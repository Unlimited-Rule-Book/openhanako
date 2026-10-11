// @vitest-environment jsdom
//
// asr-batch 的单测：云端批式语音输入的"上传 → 转写 → 交回文本"这条链。
//
// 这条路最容易错的地方有三处，测试就钉死它们：
//   1. 必须先把音频上传成会话文件拿到 fileId，再去调转写（顺序不能反、fileId 不能丢）
//   2. transcribeAudio 内部会吞掉异常返回 status:'failed'，**不会 throw** ——
//      漏判状态就会把失败当空结果静默略过（用户看到的是"说了半天什么都没出"）
//   3. abort 之后不许再回调（用户在转写途中取消了）

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBatchAsrSession } from '../../services/asr-batch';

/** 云端批式必须显式带模型（与作者的「语音条转录模型」解耦） */
const BATCH_MODEL = { provider: 'dashscope', id: 'paraformer-v2' };

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: mocks.hanaFetch,
}));

/** 造一片 PCM（int16 LE） */
function pcm(sampleCount: number): ArrayBuffer {
  const buffer = new ArrayBuffer(sampleCount * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < sampleCount; i += 1) view.setInt16(i * 2, (i % 100) - 50, true);
  return buffer;
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('云端批式语音输入', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('先上传拿 fileId，再调转写，最后把文本交给 onEndpoint / onFinal', async () => {
    mocks.hanaFetch.mockImplementation(async (url: string) => {
      if (url === '/api/upload-blob') return jsonResponse({ uploads: [{ fileId: 'sf_voice_1' }] });
      if (url === '/api/media/asr/transcribe') return jsonResponse({ transcription: { status: 'ready', text: '你好，世界。' } });
      throw new Error(`unexpected url: ${url}`);
    });

    const handlers = { onEndpoint: vi.fn(), onFinal: vi.fn(), onError: vi.fn() };
    const session = createBatchAsrSession({ sessionPath: '/session/a.jsonl', handlers, batchModel: BATCH_MODEL });

    session.sendPcm(pcm(1600));
    session.sendPcm(pcm(1600));
    session.finish();

    await vi.waitFor(() => expect(handlers.onFinal).toHaveBeenCalled());

    // 调用顺序：先上传，后转写
    const urls = mocks.hanaFetch.mock.calls.map((call) => call[0]);
    expect(urls).toEqual(['/api/upload-blob', '/api/media/asr/transcribe']);

    // 上传体里必须带 sessionPath 与 voice-input 这个 presentation
    const uploadBody = JSON.parse(mocks.hanaFetch.mock.calls[0][1].body);
    expect(uploadBody.sessionPath).toBe('/session/a.jsonl');
    expect(uploadBody.presentation).toBe('voice-input');
    expect(uploadBody.mimeType).toBe('audio/wav');
    expect(uploadBody.base64Data.length).toBeGreaterThan(0);

    // 转写请求带上了上一步拿到的 fileId，以及**显式指定的模型**
    // （不显式传的话服务端会退回作者的「语音条转录模型」，就又耦合回去了）
    const transcribeBody = JSON.parse(mocks.hanaFetch.mock.calls[1][1].body);
    expect(transcribeBody).toEqual({
      sessionPath: '/session/a.jsonl',
      fileId: 'sf_voice_1',
      providerId: 'dashscope',
      modelId: 'paraformer-v2',
    });

    // 文本一次性落文档：endpoint 给文本，final 的 pending 为空（避免重复插入）
    expect(handlers.onEndpoint).toHaveBeenCalledWith('你好，世界。', 0);
    expect(handlers.onFinal).toHaveBeenCalledWith({ text: '你好，世界。', segments: ['你好，世界。'], pending: '' });
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it('转写返回 status:failed 要走 onError（它不会 throw，漏判就会被静默略过）', async () => {
    mocks.hanaFetch.mockImplementation(async (url: string) => {
      if (url === '/api/upload-blob') return jsonResponse({ uploads: [{ fileId: 'sf_voice_2' }] });
      return jsonResponse({ transcription: { status: 'failed', error: '云端识别失败' } });
    });

    const handlers = { onEndpoint: vi.fn(), onFinal: vi.fn(), onError: vi.fn() };
    const session = createBatchAsrSession({ sessionPath: '/session/a.jsonl', handlers, batchModel: BATCH_MODEL });

    session.sendPcm(pcm(800));
    session.finish();

    await vi.waitFor(() => expect(handlers.onError).toHaveBeenCalled());
    expect(handlers.onError.mock.calls[0][0]).toContain('云端识别失败');
    expect(handlers.onEndpoint).not.toHaveBeenCalled();
  });

  it('上传没拿到 fileId 要报错，不能硬着头皮往下调转写', async () => {
    mocks.hanaFetch.mockImplementation(async () => jsonResponse({ uploads: [{ error: 'blob too large' }] }));

    const handlers = { onEndpoint: vi.fn(), onFinal: vi.fn(), onError: vi.fn() };
    const session = createBatchAsrSession({ sessionPath: '/session/a.jsonl', handlers, batchModel: BATCH_MODEL });

    session.sendPcm(pcm(800));
    session.finish();

    await vi.waitFor(() => expect(handlers.onError).toHaveBeenCalled());
    expect(handlers.onError.mock.calls[0][0]).toContain('blob too large');
  });

  it('没有会话（首页新会话还没建立）时明确报错', async () => {
    const handlers = { onEndpoint: vi.fn(), onFinal: vi.fn(), onError: vi.fn() };
    const session = createBatchAsrSession({ sessionPath: null, handlers, batchModel: BATCH_MODEL });

    session.sendPcm(pcm(800));
    session.finish();

    await vi.waitFor(() => expect(handlers.onError).toHaveBeenCalled());
    expect(mocks.hanaFetch).not.toHaveBeenCalled();
  });

  it('没选批式模型时给出专用错误码，且不发任何请求', async () => {
    // 这个错误码会被前端翻译成"去设置里选一个模型"的人话提示
    const handlers = { onEndpoint: vi.fn(), onFinal: vi.fn(), onError: vi.fn() };
    const session = createBatchAsrSession({ sessionPath: '/session/a.jsonl', handlers, batchModel: null });

    session.sendPcm(pcm(800));
    session.finish();

    await vi.waitFor(() => expect(handlers.onError).toHaveBeenCalled());
    expect(handlers.onError.mock.calls[0][0]).toBe('BATCH_MODEL_NOT_CONFIGURED');
    expect(mocks.hanaFetch).not.toHaveBeenCalled();
  });

  it('没录到声音不发起请求', async () => {
    const handlers = { onEndpoint: vi.fn(), onFinal: vi.fn(), onError: vi.fn() };
    const session = createBatchAsrSession({ sessionPath: '/session/a.jsonl', handlers, batchModel: BATCH_MODEL });

    session.finish();

    await vi.waitFor(() => expect(handlers.onError).toHaveBeenCalled());
    expect(mocks.hanaFetch).not.toHaveBeenCalled();
  });

  it('abort 之后不再回调（用户在转写途中取消）', async () => {
    let releaseUpload: (() => void) | null = null;
    mocks.hanaFetch.mockImplementation(async (url: string) => {
      if (url === '/api/upload-blob') {
        await new Promise<void>((resolve) => { releaseUpload = resolve; });
        return jsonResponse({ uploads: [{ fileId: 'sf_voice_3' }] });
      }
      return jsonResponse({ transcription: { status: 'ready', text: '不该出现' } });
    });

    const handlers = { onEndpoint: vi.fn(), onFinal: vi.fn(), onError: vi.fn() };
    const session = createBatchAsrSession({ sessionPath: '/session/a.jsonl', handlers, batchModel: BATCH_MODEL });

    session.sendPcm(pcm(800));
    session.finish();
    await vi.waitFor(() => expect(releaseUpload).not.toBeNull());

    session.abort();
    releaseUpload!();
    // 让剩下的异步链跑完
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(handlers.onEndpoint).not.toHaveBeenCalled();
    expect(handlers.onFinal).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
  });
});
