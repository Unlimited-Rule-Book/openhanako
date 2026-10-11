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

/**
 * 子进程就绪的**兜底**识别方式：`[asr-sidecar] 模型加载完成（443ms），监听 ws://127.0.0.1:12345`。
 * 优先通道是 sidecar 打的那行 JSON（`{"asrSidecarReady":true,"port":N}`）—— 见下面的解析函数。
 */
const READY_RE = /监听\s+ws:\/\/127\.0\.0\.1:(\d+)/;
const START_TIMEOUT_MS = 30_000;

/**
 * 从 sidecar 的一行输出里解析出监听端口；不是就绪行就返回 null。
 *
 * **先认 JSON**（sidecar 明确承诺的接口），中文日志只作兜底 ——
 * 靠人类可读文案判定就绪，文案改一个字（加括号、改措辞、翻译）就会静默失效，
 * 而且失败方式是「卡住直到超时」，排查时要翻到这里才知道为什么。
 */
export function parseSidecarReadyLine(line: string): number | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { asrSidecarReady?: boolean; port?: number };
      if (parsed?.asrSidecarReady && Number.isFinite(parsed.port)) return Number(parsed.port);
    } catch {
      // 不是合法 JSON（比如日志恰好以 { 开头）：继续走下面的兜底
    }
  }
  const match = trimmed.match(READY_RE);
  return match ? Number(match[1]) : null;
}

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
  /** 启动编号：区分"哪一次启动"，避免旧进程的迟到事件替新启动收尾（或反之） */
  let pendingToken = 0;
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

  function startOnce(modelDir?: string, startToken = 0): Promise<AsrSidecarStatus> {
    const preflightError = preflight();
    if (preflightError) {
      error = preflightError;
      return Promise.resolve(status());
    }

    return new Promise((resolve) => {
      /**
       * 这次启动还算不算「当前挂起的那一次」。
       *
       * 用它回答"该不该由我来收掉这个 Promise"：旧进程迟到退出时，如果已经有更新的启动在飞，
       * 就**绝不能**替它收尾 —— 否则那边会拿到"未就绪"，以为失败又去启动第三个进程，越积越多。
       * 而如果这次启动就是挂起的那一次（典型：启动过程中用户调了 stop()），就必须收掉，
       * 否则调用方会一直等到 30 秒超时。
       */
      const isThisPendingStart = () => pendingToken === startToken;
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
        // 必须杀**这次启动的那个**进程。共享的 child 可能早就指向后来启动的新进程 ——
        // 那个进程是好的，只是这次启动的计时器恰好晚到了，用它会把新进程误杀。
        try { spawned.kill(); } catch { /* 已经退出 */ }
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
        // stdin 给管道（不能是 'ignore'）：它同时是子进程的"生命线"。
        // 应用被强杀时父进程来不及发信号，但管道写端会随父进程一起关闭，
        // sidecar 侧收到 stdin 的 end/close 就会自己退出（见 server.mjs），
        // 否则它抱着几百 MB 模型内存变成没人回收的孤儿进程。
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child = spawned;
      currentModelDir = modelDir ?? null;

      let stdoutBuf = '';
      spawned.stdout?.on('data', (chunk) => {
        stdoutBuf += String(chunk);
        // 按行切：最后一段可能还没换行，通常要留到下一块数据再拼。
        // 但**也要拿它试一次**：真实 sidecar 用 console.log 会带换行，
        // 而"最后一行之后再也没有输出"是完全可能的（进程就此安静），
        // 那时它就是完整的 —— 只按"有换行才算完整"会把这种正常情形判成永不就绪。
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        if (port !== null) return;
        for (const line of [...lines, stdoutBuf]) {
          const parsedPort = parseSidecarReadyLine(line);
          if (parsedPort === null) continue;
          port = parsedPort;
          error = null;
          log(`sidecar 就绪，端口 ${port}`);
          done();
          return;
        }
      });

      // 子进程的错误输出只在失败时才有用，攒着不刷屏
      let stderrBuf = '';
      spawned.stderr?.on('data', (chunk) => {
        stderrBuf += String(chunk);
        if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
      });

      spawned.on('error', (err) => {
        // 同 exit 的道理：只有"当前这个 child"的错误才配改状态，
        // 被替换掉的旧进程报错不该把新进程的记录抹掉。
        if (child !== spawned) {
          // 但该收的账要收：被替换掉的旧进程只可能属于"上一次启动"，
          // 若那次启动的 Promise 还挂着（启动过程中调了 stop()），在这里收掉它，
          // 否则调用方要白等到 30 秒超时。
          if (isThisPendingStart()) done();
          return;
        }
        error = `sidecar 启动失败：${err.message}`;
        log(error);
        child = null;
        done();
      });

      spawned.on('exit', (code, signal) => {
        // 关键：只清理"当前这个 child"的状态。换模型时旧进程被 stop() kill，
        // 它的 exit 事件常常**晚于**新进程启动才到达；此时 child 已经指向新进程，
        // 若无条件把 child/port/pending 一并置空，就会把新进程的记录覆盖掉 ——
        // 新进程从此失去跟踪，stop() 关不掉它，变成孤儿进程。
        if (child !== spawned) {
          // 该收的账要收：见上面 error 处理的同一条理由。
          // （只有"本次启动就是当前挂着的那一次"才收，避免把更新的启动提前解决掉）
          if (isThisPendingStart()) done();
          log(`被替换的旧 sidecar 已退出（code=${code} signal=${signal}），当前进程不受影响`);
          return;
        }
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
    // 启动编号：让"这一次启动"能在 finally / 事件回调里认出自己，
    // 从而只清自己的账、不去动后来者的挂起状态。
    const token = ++pendingToken;
    pending = startOnce(modelDir, token).finally(() => {
      if (pendingToken === token) pending = null;
    });
    return pending;
  }

  function stop() {
    const target = child;
    child = null;
    port = null;
    currentModelDir = null;
    // 顺手清掉挂起记录：刚停掉就又要启动时，不该被"上一次（已作废）的启动"挡住。
    // 注意这里**不动** pendingToken —— 那次启动的 Promise 还要靠旧进程的 exit 来收掉
    // （见 exit 处理里的 isThisPendingStart），把编号改掉就等于让它永远收不了尾了。
    pending = null;
    if (target && !target.killed) {
      log('正在停止语音识别 sidecar');
      try { target.kill(); } catch { /* 已经退出 */ }
    }
  }

  return { ensureStarted, stop, status };
}
