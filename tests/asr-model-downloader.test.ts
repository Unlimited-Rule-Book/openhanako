/**
 * 本地模型下载器。
 *
 * 这里用**假的模型清单 + 假的 fetch**，因为要验证的是下载逻辑本身
 * （缺失判断、镜像回退、校验、断点续传），而不是真的把几百 MB 权重拉下来。
 *
 * 四条契约：
 *   1. **只下缺的**（"标点已装就不再下"就靠这条 —— 用户明确要求的核心行为）
 *   2. **校验不过就换源**（拿到坏文件必须被挡住，否则 sidecar 起不来还怪用户）
 *   3. **失败留 .part、成功才改名**（残缺文件永远不叫正式名字 → 不会被当成"已安装"）
 *   4. **续传时哈希要对**（先补算已下部分的字节；这里最容易写错，所以单独测）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAsrModelDownloader } from '../server/asr-model-downloader.ts';
import type { LocalModelSpec } from '../core/speech-recognition/local-models.ts';

let modelsRoot = '';

const FILE_A = 'tiny-a.bin';
const FILE_B = 'tiny-b.bin';
const CONTENT_A = Buffer.from('aaaa-aaaa-aaaa'); // 15 bytes
const CONTENT_B = Buffer.from('bbbbbbbbbbbbbbbbbbbb'); // 20 bytes

function sha256(buf: Buffer) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 两个假模型：asr-model 两个文件、punct 一个文件（对应真实结构） */
const specs: LocalModelSpec[] = [
  {
    id: 'asr-model',
    dir: 'fake-asr',
    repo: 'fake/asr',
    role: 'asr',
    files: [
      { name: FILE_A, size: CONTENT_A.length, sha256: sha256(CONTENT_A) },
      { name: FILE_B, size: CONTENT_B.length, sha256: sha256(CONTENT_B) },
    ],
  },
  {
    id: 'punct',
    dir: 'fake-punct',
    repo: 'fake/punct',
    role: 'punctuation',
    files: [{ name: FILE_A, size: CONTENT_A.length, sha256: sha256(CONTENT_A) }],
  },
];

function bodyFrom(buf: Buffer, onConsumed?: () => void) {
  return {
    async *[Symbol.asyncIterator]() {
      yield buf;
      // yield 恢复的时机 = 下载器已把这个 chunk 计入 received —— 在这里抓进度快照正合适
      if (onConsumed) onConsumed();
    },
  } as unknown as ReadableStream<Uint8Array>;
}

/** 假 fetch：按 URL 决定返回什么；可注入失败/坏内容/是否支持 Range */
function makeFetch(plan: Record<string, { content?: Buffer; status?: number } | 'network-error'>, onBodyConsumed?: () => void) {
  return vi.fn(async (url: string, init?: any) => {
    const key = url.includes('hf-mirror') ? 'mirror' : 'official';
    const rule = plan[key];
    if (!rule || rule === 'network-error') throw new Error('network down');
    if (rule.status && rule.status >= 400) {
      return { ok: false, status: rule.status, body: null } as unknown as Response;
    }
    const content = rule.content as Buffer;
    const range = init?.headers?.Range as string | undefined;
    const start = range ? Number(range.replace('bytes=', '').replace('-', '')) : 0;
    const slice = content.subarray(start);
    return {
      ok: true,
      status: start > 0 ? 206 : 200,
      body: bodyFrom(slice, onBodyConsumed),
    } as unknown as Response;
  });
}

function makeDownloader(fetchImpl: any) {
  return createAsrModelDownloader({ modelsRoot, fetchImpl, specs, log: () => {} });
}

beforeEach(() => {
  modelsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-models-test-'));
});

afterEach(() => {
  fs.rmSync(modelsRoot, { recursive: true, force: true });
});

describe('本地模型下载器', () => {
  it('只下缺失的文件：标点已装时不再重复下载（用户要求的核心行为）', async () => {
    // 先把 punct 装好（模拟"上一轮已经下过标点"）
    const punctDir = path.join(modelsRoot, 'fake-punct');
    fs.mkdirSync(punctDir, { recursive: true });
    fs.writeFileSync(path.join(punctDir, FILE_A), CONTENT_A);

    const fetchImpl = makeFetch({ mirror: { content: CONTENT_A }, official: { content: CONTENT_A } });
    const downloader = makeDownloader(fetchImpl);
    const plan = downloader.buildPlan(['punct']);

    expect(plan).toEqual([]); // 没有要下的文件
    const result = await downloader.start({ ids: ['punct'] });
    expect(result).toEqual({ alreadyInstalled: true });
    expect(fetchImpl).not.toHaveBeenCalled(); // 一个请求都没发
  });

  it('校验不过就换源；换源成功后落盘为正式文件名', async () => {
    const bad = Buffer.from('WRONG-CONTENT!!'); // 长度或校验值都不对
    const fetchImpl = makeFetch({ mirror: { content: bad }, official: { content: CONTENT_A } });
    const downloader = makeDownloader(fetchImpl);

    await downloader.start({ ids: ['punct'] });

    expect(downloader.getState().error).toBeNull();
    // 最终文件内容正确，且没有留下 .part
    const saved = fs.readFileSync(path.join(modelsRoot, 'fake-punct', FILE_A));
    expect(saved.equals(CONTENT_A)).toBe(true);
    expect(fs.existsSync(path.join(modelsRoot, 'fake-punct', FILE_A + '.part'))).toBe(false);
    // 第一次用了镜像，失败后换了官方源
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('huggingface'))).toBe(true);
  });

  it('所有源都失败时：报错、且不把残缺文件当成已安装', async () => {
    const fetchImpl = makeFetch({ mirror: 'network-error', official: 'network-error' });
    const downloader = makeDownloader(fetchImpl);

    await downloader.start({ ids: ['punct'] });

    expect(downloader.getState().error).toContain('下载失败');
    // 正式文件不存在 → 界面仍会显示"需要下载"，不会被误判为已装
    expect(fs.existsSync(path.join(modelsRoot, 'fake-punct', FILE_A))).toBe(false);
    expect(downloader.modelStatus().find((m) => m.id === 'punct')?.state).toBe('missing');
  });

  it('断点续传：已下的前半段被复用，最终校验仍然通过', async () => {
    const dir = path.join(modelsRoot, 'fake-punct');
    fs.mkdirSync(dir, { recursive: true });
    // 先放一个"下到一半"的 .part
    const half = CONTENT_A.subarray(0, 6);
    fs.writeFileSync(path.join(dir, FILE_A + '.part'), half);

    const fetchImpl = makeFetch({ mirror: { content: CONTENT_A }, official: { content: CONTENT_A } });
    const downloader = makeDownloader(fetchImpl);
    await downloader.start({ ids: ['punct'] });

    // 发过带 Range 的请求（说明真的续传了，而不是从头下）
    const ranged = fetchImpl.mock.calls.find(([, init]) => init?.headers?.Range === `bytes=${half.length}-`);
    expect(ranged).toBeTruthy();
    // 续传后的文件内容完整、校验通过（哈希补算这一步写错的话这条会红）
    expect(fs.readFileSync(path.join(dir, FILE_A)).equals(CONTENT_A)).toBe(true);
    expect(downloader.getState().error).toBeNull();
  });

  it('进度按字节累计（下载中可观察），完成后状态清空、界面回到可再次下载', async () => {
    let downloader: ReturnType<typeof makeDownloader> | undefined;
    const snapshots: Array<{ received: number; total: number; ids: string[] }> = [];
    const fetchImpl = makeFetch(
      { mirror: { content: CONTENT_A }, official: { content: CONTENT_A } },
      () => {
        const s = downloader!.getState();
        snapshots.push({ received: s.received, total: s.total, ids: [...s.ids] });
      },
    );
    downloader = makeDownloader(fetchImpl);

    const { state } = await downloader.start({ ids: ['punct'] });

    // 下载中：total = 计划总字节；最后一个 chunk 计入后 received 追平 total
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[snapshots.length - 1].total).toBe(CONTENT_A.length);
    expect(snapshots[snapshots.length - 1].received).toBe(CONTENT_A.length);
    expect(snapshots[snapshots.length - 1].ids).toContain('punct');
    // 完成后：download 状态清空（它只承载"进行中/待处理的失败"）——
    // 之前成功后残留 ids 导致前端永远卡在"下载中 100%"
    expect(state.ids).toEqual([]);
    expect(state.total).toBe(0);
    // 事实由模型清单状态表达：标点此刻应显示就绪
    expect(downloader.modelStatus().find((m) => m.id === 'punct')?.state).toBe('ready');
  });

  it('modelStatus 能反映"部分安装"（缺哪个文件、还差多少字节）', () => {
    const dir = path.join(modelsRoot, 'fake-asr');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, FILE_A), CONTENT_A); // 只装了一个文件

    const downloader = makeDownloader(makeFetch({}));
    const entry = downloader.modelStatus().find((m) => m.id === 'asr-model');

    expect(entry?.state).toBe('partial');
    expect(entry?.missingBytes).toBe(CONTENT_B.length); // 只差 B
  });

  it('失败后能再次启动下载（回归：判据用 state 非空会把"重试"挡掉）', async () => {
    // 第一次全源失败；把开关放开后再点"重试"
    let networkDown = true;
    const fetchImpl = vi.fn(async () => {
      if (networkDown) throw new Error('network down');
      return { ok: true, status: 200, body: bodyFrom(CONTENT_A) } as unknown as Response;
    });
    const downloader = makeDownloader(fetchImpl);

    await downloader.start({ ids: ['punct'] });
    expect(downloader.getState().error).toContain('下载失败');
    expect(downloader.isRunning()).toBe(false); // 已经结束了，不该还自称"进行中"

    networkDown = false;
    // 关键断言：这一次必须真的开始下载，而不是抛"已有模型下载在进行中"
    await downloader.start({ ids: ['punct'] });

    expect(downloader.getState().error).toBeNull();
    expect(fs.readFileSync(path.join(modelsRoot, 'fake-punct', FILE_A)).equals(CONTENT_A)).toBe(true);
  });

  it('isRunning 只在真的有下载在跑时为真（失败态保留 ≠ 进行中）', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: {
        async *[Symbol.asyncIterator]() {
          await gate; // 卡住，制造"正在下载"的窗口
          yield CONTENT_A;
        },
      } as unknown as ReadableStream<Uint8Array>,
    } as unknown as Response));
    const downloader = makeDownloader(fetchImpl);

    const running = downloader.start({ ids: ['punct'] });
    await Promise.resolve();
    expect(downloader.isRunning()).toBe(true);

    release?.();
    await running;
    // 成功后状态清空（这正是"卡死 100%"那个 bug 的根因所在）
    expect(downloader.isRunning()).toBe(false);
    expect(downloader.getState().ids).toEqual([]);
  });

  it('连接卡住（不再有数据）按失败处理，并换到下一个源（拔网不会永远"下载中"）', async () => {
    // 镜像源：先给 4 个字节，然后彻底不动（模拟网线被拔：TCP 不报错，只是不再来数据）
    const fetchImpl = vi.fn(async (url: string, init?: any) => {
      if (!String(url).includes('hf-mirror')) {
        return { ok: true, status: 200, body: bodyFrom(CONTENT_A) } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        body: {
          async *[Symbol.asyncIterator]() {
            yield CONTENT_A.subarray(0, 4);
            await new Promise((_, reject) => {
              const signal = init?.signal as AbortSignal | undefined;
              if (signal?.aborted) return reject(new Error('aborted'));
              signal?.addEventListener('abort', () => reject(new Error('aborted')));
            });
          },
        } as unknown as ReadableStream<Uint8Array>,
      } as unknown as Response;
    });
    const downloader = createAsrModelDownloader({
      modelsRoot, fetchImpl, specs, stallTimeoutMs: 30, log: () => {},
    });

    await downloader.start({ ids: ['punct'] });

    // 卡死被当成"这个源不行"→ 换源成功，而不是永远挂在"下载中"
    expect(downloader.getState().error).toBeNull();
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('huggingface'))).toBe(true);
    expect(fs.readFileSync(path.join(modelsRoot, 'fake-punct', FILE_A)).equals(CONTENT_A)).toBe(true);
    expect(downloader.isRunning()).toBe(false);
  });

  it('用户取消 ≠ 卡死：取消要往上抛（走"已取消"，不是"换源重试"）', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: any) => ({
      ok: true,
      status: 200,
      body: {
        // 不用生成器：它从头到尾不会 yield（只等 abort 然后 reject），
        // eslint 的 require-yield 会把这种"假生成器"判成错误（CI 就是被这条拦下的）。
        // 也不要"async 方法直接返回 Promise"那种写法 —— 那会改变 await 的时序。
        // 这里给一个**最小迭代器**：next() 一直等到 abort 再拒绝，行为与原来的生成器一致。
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<Uint8Array>>((_, reject) => {
              const signal = init?.signal as AbortSignal | undefined;
              if (signal?.aborted) return reject(new Error('aborted'));
              signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
          };
        },
      } as unknown as ReadableStream<Uint8Array>,
    } as unknown as Response));

    const downloader = createAsrModelDownloader({ modelsRoot, fetchImpl, specs, stallTimeoutMs: 5000, log: () => {} });
    const running = downloader.start({ ids: ['punct'] });
    await Promise.resolve();
    downloader.cancel();
    await running;

    const snapshot = downloader.getState();
    expect(snapshot.cancelled).toBe(true);
    expect(snapshot.error).toBeNull();
    // 取消只试了一次源（没有"换源重试"）
    expect(fetchImpl.mock.calls.length).toBe(1);
  });

  it('换源时进度不重复计（进度 = 盘上真实字节数，而不是"两次尝试相加"）', async () => {
    // 这个用例盯的是记账不变式：失败那次已经计过的字节，下一个源会通过 writeFrom 重新计入。
    // 如果失败路径没有回退自己加过的，同一批字节就会被计两遍（16 字节的文件会显示成 12/15）。
    let downloader: any = null;
    let sampledReceived = -1;
    const fetchImpl = vi.fn(async (url: string, init?: any) => {
      const range = init?.headers?.Range as string | undefined;
      if (String(url).includes('hf-mirror')) {
        // 第一个源：给 6 字节后卡死（模拟拔网）
        return {
          ok: true, status: 200,
          body: {
            async *[Symbol.asyncIterator]() {
              yield CONTENT_A.subarray(0, 6);
              await new Promise((_, reject) => {
                const signal = init?.signal as AbortSignal | undefined;
                if (signal?.aborted) return reject(new Error('aborted'));
                signal?.addEventListener('abort', () => reject(new Error('aborted')));
              });
            },
          } as unknown as ReadableStream<Uint8Array>,
        } as unknown as Response;
      }
      // 第二个源：支持 Range，接着下。在这里采样进度。
      const start = range ? Number(range.replace('bytes=', '').replace('-', '')) : 0;
      return {
        ok: true, status: start > 0 ? 206 : 200,
        body: {
          async *[Symbol.asyncIterator]() {
            sampledReceived = downloader.getState().received;
            yield CONTENT_A.subarray(start);
          },
        } as unknown as ReadableStream<Uint8Array>,
      } as unknown as Response;
    });

    downloader = createAsrModelDownloader({ modelsRoot, fetchImpl, specs, stallTimeoutMs: 30, log: () => {} });
    await downloader.start({ ids: ['punct'] });

    expect(downloader.getState().error).toBeNull();
    // 6 = 盘上已有的那 6 字节（只计一次）；若是 12 说明第一次尝试的字节没被回退
    expect(sampledReceived).toBe(6);
    expect(fs.readFileSync(path.join(modelsRoot, 'fake-punct', FILE_A)).equals(CONTENT_A)).toBe(true);
  });
});
