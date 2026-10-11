/**
 * asr-sidecar-manager.ts — 本地语音识别 sidecar 的生命周期管理
 *
 * 职责：按需拉起 tools/asr-sidecar/server.mjs、记住它监听的端口、在服务端退出时收掉它。
 *
 * 为什么用独立进程（而不是在服务端里直接 require 原生模块）：
 *  1. 原生 ASR 引擎崩溃（native abort）不会把整个服务端拽下水；
 *  2. 换引擎（更大的本地模型 / 云端流式）不用动服务端代码；
 *  3. 模型常驻内存与 HTTP 服务的生命周期解耦。
 *  注：并不是"不拆就一定加载不了"——服务端本身跑在独立 Node 运行时里（见
 *  desktop/main.cjs 里的 dev/packaged 分支），ABI 是自洽的。这里图的是隔离与可替换。
 *
 * 端口用 0（由系统分配），真实端口从子进程 stdout 的 ready 行里解析出来，
 * 避免固定端口在用户机器上撞车。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 子进程 ready 行：`[asr-sidecar] 模型加载完成（443ms），监听 ws://127.0.0.1:12345` */
const READY_RE = /监听\s+ws:\/\/127\.0\.0\.1:(\d+)/;
const START_TIMEOUT_MS = 30_000;

export interface AsrSidecarStatus {
  ready: boolean;
  port: number | null;
  error: string | null;
}

export function createAsrSidecarManager({
  rootDir,
  modelsRoot,
  log = () => {},
}: {
  rootDir: string;
  /**
   * 模型根目录。由调用方注入（见 core/speech-recognition/local-models.ts 的 resolveModelsRoot）：
   * 开发时是仓库里的 tools/asr-sidecar/models，打包后是应用数据目录。
   * 不传就退回脚本同级的 models/（兼容老行为）。
   */
  modelsRoot?: string;
  log?: (msg: string) => void;
}) {
  const sidecarDir = path.join(rootDir, 'tools', 'asr-sidecar');
  const resolvedModelsRoot = modelsRoot || path.join(sidecarDir, 'models');
  const scriptPath = path.join(sidecarDir, 'server.mjs');

  let child: ChildProcess | null = null;
  let port: number | null = null;
  let error: string | null = null;
  let pending: Promise<AsrSidecarStatus> | null = null;
  // 当前已加载的模型目录名（一个 sidecar 进程只加载一个模型，换模型要重启）
  let currentModelDir: string | null = null;

  function status(): AsrSidecarStatus {
    return { ready: port !== null, port, error };
  }

  /** 尽力给出可操作的报错，而不是让用户对着 "ENOENT" 发呆 */
  function preflight(): string | null {
    if (!fs.existsSync(scriptPath)) {
      return `找不到 sidecar 脚本：${scriptPath}`;
    }
    if (!fs.existsSync(path.join(sidecarDir, 'node_modules', 'sherpa-onnx-node'))) {
      return 'sidecar 依赖未安装。请先执行：cd tools/asr-sidecar && npm install';
    }
    if (!fs.existsSync(resolvedModelsRoot)) {
      return '本地识别模型还没下载。可在「设置 → 多媒体 → 语音识别」里点下载';
    }
    return null;
  }

  function startOnce(modelDir?: string): Promise<AsrSidecarStatus> {
    const preflightError = preflight();
    if (preflightError) {
      error = preflightError;
      return Promise.resolve(status());
    }

    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(status());
      };

      const timer = setTimeout(() => {
        error = `sidecar 启动超时（${START_TIMEOUT_MS}ms）`;
        log(error);
        try { child?.kill(); } catch { /* 已经退出 */ }
        done();
      }, START_TIMEOUT_MS);

      log('正在拉起语音识别 sidecar…');
      const args = [scriptPath, '--port', '0'];
      if (modelDir) args.push('--model', modelDir);
      const spawned = spawn(process.execPath, args, {
        cwd: sidecarDir,
        // 服务端本身可能由 Electron 拉起；子进程必须是真 Node。
        // 这个变量对真 Node 是无害的空操作。
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          // 把模型根目录显式传给 sidecar，让它去用我们下载到的那个位置
          HANA_ASR_MODELS_ROOT: resolvedModelsRoot,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child = spawned;
      currentModelDir = modelDir ?? null;

      let stdoutBuf = '';
      spawned.stdout?.on('data', (chunk) => {
        stdoutBuf += String(chunk);
        const m = stdoutBuf.match(READY_RE);
        if (m && port === null) {
          port = Number(m[1]);
          error = null;
          log(`sidecar 就绪，端口 ${port}`);
          done();
        }
      });

      // 子进程的错误输出只在失败时才有用，攒着不刷屏
      let stderrBuf = '';
      spawned.stderr?.on('data', (chunk) => {
        stderrBuf += String(chunk);
        if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
      });

      spawned.on('error', (err) => {
        error = `sidecar 启动失败：${err.message}`;
        log(error);
        child = null;
        done();
      });

      spawned.on('exit', (code, signal) => {
        const wasReady = port !== null;
        child = null;
        port = null;
        pending = null;
        if (wasReady) {
          log(`sidecar 已退出（code=${code} signal=${signal}）`);
          error = null;
        } else if (!settled) {
          const tail = stderrBuf.trim().split('\n').slice(-3).join(' | ');
          error = `sidecar 异常退出（code=${code}）${tail ? `：${tail}` : ''}`;
          log(error);
        }
        done();
      });
    });
  }

  /** 幂等：已经在跑就直接返回端口；并发调用共用同一个启动 Promise。 */
  function ensureStarted(modelDir?: string): Promise<AsrSidecarStatus> {
    // 一个 sidecar 进程只加载一个模型，请求的模型变了就先收掉再重启
    if (port !== null && currentModelDir !== (modelDir ?? null)) {
      stop();
    }
    if (port !== null) return Promise.resolve(status());
    if (pending) return pending;
    pending = startOnce(modelDir).finally(() => { pending = null; });
    return pending;
  }

  function stop() {
    const target = child;
    child = null;
    port = null;
    currentModelDir = null;
    if (target && !target.killed) {
      log('正在停止语音识别 sidecar');
      try { target.kill(); } catch { /* 已经退出 */ }
    }
  }

  return { ensureStarted, stop, status };
}
