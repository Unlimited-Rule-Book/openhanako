import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createAsrSidecarManager } from '../server/asr-sidecar-manager.ts';
import { getLocalModelSpec, inspectLocalModel } from '../core/speech-recognition/local-models.ts';
import { DEFAULT_LOCAL_MODEL_ID } from '../core/speech-recognition/input-engines.ts';

/**
 * sidecar 生命周期管理的集成测试。
 *
 * 注意：这里会**真的拉起子进程**（不是打桩），因为要验证的核心恰恰是
 * "能不能起来、端口对不对、能不能连上" —— 打桩就全测不到了。
 *
 * 模型与依赖是本地下载的，CI 上没有，所以缺了整体跳过，不让 CI 变红。
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sidecarDir = path.join(rootDir, 'tools', 'asr-sidecar');
/**
 * 前置条件：脚本、原生依赖、以及**默认模型确实装全了**。
 *
 * 最后一条不能只判"models 目录在不在" —— 目录在但缺文件（比如只下了双语和标点、
 * 没下默认的中文模型）时 sidecar 照样起不来，测试就会红。
 * 这里直接复用**应用自己的判定**（inspectLocalModel + 真实清单），
 * 免得测试的前置条件与产品的实际要求各说各话、日后漂移。
 */
const modelsRootForTest = path.join(sidecarDir, 'models');
function defaultModelReady(): boolean {
  const spec = getLocalModelSpec(DEFAULT_LOCAL_MODEL_ID);
  if (!spec) return false;
  const inspected = inspectLocalModel(spec, modelsRootForTest, fs.existsSync, (p) => {
    try { return fs.statSync(p).size; } catch { return -1; }
  });
  return inspected.state === 'ready';
}

const sidecarReady =
  fs.existsSync(path.join(sidecarDir, 'server.mjs'))
  && fs.existsSync(path.join(sidecarDir, 'node_modules', 'sherpa-onnx-node'))
  && defaultModelReady();

describe.skipIf(!sidecarReady)('asr-sidecar-manager', () => {
  const manager = createAsrSidecarManager({ rootDir });
  afterAll(() => manager.stop());

  it('按需拉起 sidecar，并拿到真实端口', async () => {
    const status = await manager.ensureStarted();

    expect(status.error).toBeNull();
    expect(status.ready).toBe(true);
    expect(status.port).toBeGreaterThan(0);
  }, 60_000);

  it('幂等：并发重复调用只起一个进程，端口一致', async () => {
    const first = await manager.ensureStarted();
    const [a, b] = await Promise.all([manager.ensureStarted(), manager.ensureStarted()]);

    expect(a.port).toBe(first.port);
    expect(b.port).toBe(first.port);
  }, 60_000);

  it('端口真的可用：连得上，且 ping 有 pong', async () => {
    const { port } = await manager.ensureStarted();

    const pong = await new Promise<{ type: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const timer = setTimeout(() => { ws.close(); reject(new Error('等 pong 超时')); }, 10_000);
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'ping' })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'pong') { clearTimeout(timer); ws.close(); resolve(msg); }
      });
    });

    expect(pong.type).toBe('pong');
  }, 30_000);

  it('依赖缺失时返回可操作的报错，而不是抛异常', async () => {
    const broken = createAsrSidecarManager({ rootDir: path.join(rootDir, 'no-such-root') });

    const status = await broken.ensureStarted();

    expect(status.ready).toBe(false);
    expect(status.error).toContain('找不到 sidecar 脚本');
    broken.stop();
  });

  it('stop 之后状态回到未就绪', async () => {
    manager.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(manager.status().ready).toBe(false);
    expect(manager.status().port).toBeNull();
  }, 15_000);
});
