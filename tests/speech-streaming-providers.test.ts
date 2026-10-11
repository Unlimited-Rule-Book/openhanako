/**
 * 流式语音识别的模型列表（SpeechRecognitionService.listStreamingProviders）。
 *
 * 钉两件事：
 *   1. 它跟批式那套一样，**跟着供应商配置走**：凭据状态、模型清单都从 providerRegistry 实时取，
 *      不是写死的常量 —— 用户在供应商里加/删模型、删 Key，这里都要跟着变。
 *   2. 只有**有执行实现**的协议才会被列出来。声明了协议但还没写转发器的型号不能列，
 *      否则用户选得到、一按录音就失败。
 */

import { describe, expect, it, vi } from 'vitest';
import { SpeechRecognitionService } from '../core/speech-recognition-service.ts';

const STREAMING_CAPABILITY = 'speech_recognition_streaming';

function createService({ models, hasCredentials = true }: { models: any[]; hasCredentials?: boolean }) {
  const providerRegistry = {
    getMediaProviders: vi.fn((capability: string) => (
      capability === STREAMING_CAPABILITY
        ? [{ providerId: 'dashscope', displayName: 'DashScope', models }]
        : []
    )),
    getMediaProviderCredentialStatus: vi.fn(() => ({ hasCredentials })),
  };
  const service = new SpeechRecognitionService({
    providerRegistry,
    preferences: { getSpeechRecognitionConfig: () => ({ enabled: false }) },
    sessionFiles: {},
  } as never);
  return { service, providerRegistry };
}

describe('流式语音识别：可用模型列表', () => {
  it('列出有协议实现的实时型号，并带上凭据状态', () => {
    const { service } = createService({
      models: [
        { id: 'paraformer-realtime-v2', protocolId: 'dashscope-paraformer-realtime', displayName: 'Paraformer Realtime v2' },
        { id: 'fun-asr-realtime', protocolId: 'dashscope-paraformer-realtime', displayName: 'Fun-ASR Realtime' },
      ],
    });

    const providers = service.listStreamingProviders();
    expect(Object.keys(providers)).toEqual(['dashscope']);
    expect(providers.dashscope.hasCredentials).toBe(true);
    expect(providers.dashscope.models.map((m: any) => m.id)).toEqual([
      'paraformer-realtime-v2',
      'fun-asr-realtime',
    ]);
    expect(providers.dashscope.availableModels[0]).toEqual({
      id: 'paraformer-realtime-v2',
      name: 'Paraformer Realtime v2',
    });
  });

  it('没有执行实现的协议**不列出**（声明了也跑不通）', () => {
    const { service } = createService({
      models: [
        { id: 'paraformer-realtime-v2', protocolId: 'dashscope-paraformer-realtime' },
        // 假设将来某家供应商声明了流式协议，但转发器还没写：
        { id: 'some-future-realtime', protocolId: 'openai-realtime-transcription' },
      ],
    });

    const providers = service.listStreamingProviders();
    expect(providers.dashscope.models.map((m: any) => m.id)).toEqual(['paraformer-realtime-v2']);
  });

  it('没有任何可用模型时，该供应商整段不出现（与批式行为一致）', () => {
    const { service } = createService({ models: [] });
    expect(service.listStreamingProviders()).toEqual({});
  });

  it('凭据状态由 providerRegistry 实时提供（删掉 Key 后界面才能变灰）', () => {
    const { service } = createService({
      models: [{ id: 'paraformer-realtime-v2', protocolId: 'dashscope-paraformer-realtime' }],
      hasCredentials: false,
    });
    expect(service.listStreamingProviders().dashscope.hasCredentials).toBe(false);
  });

  it('listProviders 同时返回批式与流式两段，互不混淆', () => {
    const { service } = createService({
      models: [{ id: 'paraformer-realtime-v2', protocolId: 'dashscope-paraformer-realtime' }],
    });
    const result = service.listProviders();
    expect(result).toHaveProperty('providers');
    expect(result).toHaveProperty('streamingProviders');
    // 这个假 registry 只在流式能力下返回模型，所以批式那段是空的
    expect(result.providers).toEqual({});
    expect(Object.keys(result.streamingProviders)).toEqual(['dashscope']);
  });

  it('isRunnableStreamingModel 只认列表里真正可用的型号（挡住渲染层传任意值）', () => {
    const { service } = createService({
      models: [{ id: 'paraformer-realtime-v2', protocolId: 'dashscope-paraformer-realtime' }],
    });
    expect(service.isRunnableStreamingModel('dashscope', 'paraformer-realtime-v2')).toBe(true);
    expect(service.isRunnableStreamingModel('dashscope', 'qwen3-asr-flash')).toBe(false);
    expect(service.isRunnableStreamingModel('openai', 'gpt-4o-transcribe')).toBe(false);
    expect(service.isRunnableStreamingModel('dashscope', '')).toBe(false);
    expect(service.isRunnableStreamingModel(null, 'paraformer-realtime-v2')).toBe(false);
  });
});
