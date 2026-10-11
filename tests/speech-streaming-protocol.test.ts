/**
 * 流式（实时）语音识别的协议推断规则。
 *
 * 这张规则表决定"哪些型号会出现在「识别方式 = 云端流式」的模型列表里"。
 * 它有两个容易出错的方向，所以两头都要钉：
 *   · 该进的没进 —— 同族变体（带日期后缀）被漏掉；
 *   · 不该进的进了 —— 会话式协议（qwen3-asr-flash-realtime 等）与 8k 型号被放进来，
 *     用户选得到但一按录音就失败。
 *
 * 规则本体见 core/media-protocols.ts 的 STREAMING_ASR_PROTOCOLS。
 */

import { describe, expect, it } from 'vitest';
import { inferMediaProtocolId, resolveStreamingAsrProtocol } from '../core/media-protocols.ts';

const STREAMING = 'speech_recognition_streaming';
const REALTIME_PROTOCOL = 'dashscope-paraformer-realtime';

describe('流式语音识别：协议推断', () => {
  it('百炼的同族实时型号都能推断出协议（含带日期后缀的变体）', () => {
    const ids = [
      'paraformer-realtime-v2',
      'paraformer-realtime-v1',
      'fun-asr-realtime',
      // 文档里出现过带日期的型号：按族匹配就是为了不漏掉这种变体
      'fun-asr-realtime-2026-02-28',
      'qwen-audio-3.0-asr-flash-streaming',
    ];
    for (const id of ids) {
      expect(resolveStreamingAsrProtocol('dashscope', id)).toBe(REALTIME_PROTOCOL);
      expect(inferMediaProtocolId('dashscope', STREAMING, id)).toBe(REALTIME_PROTOCOL);
    }
  });

  it('会话式的实时型号必须被排除（事件名是 conversation.item.*，转发器认不了）', () => {
    for (const id of ['qwen3-asr-flash-realtime', 'qwen3.5-omni-flash-realtime', 'qwen3.5-omni-plus-realtime']) {
      expect(resolveStreamingAsrProtocol('dashscope', id)).toBe('');
    }
  });

  it('8k 型号必须被排除（前端推的是 16k 采样，要重采样才能用）', () => {
    expect(resolveStreamingAsrProtocol('dashscope', 'paraformer-realtime-8k-v2')).toBe('');
  });

  it('批式型号不会掉进流式列表里', () => {
    expect(resolveStreamingAsrProtocol('dashscope', 'qwen3-asr-flash')).toBe('');
  });

  it('没有流式规则的供应商返回空（将来给谁加流式，就在规则表里加一条）', () => {
    for (const [provider, id] of [
      ['openai', 'gpt-4o-transcribe'],
      ['mimo', 'mimo-v2.5-asr'],
      ['volcengine-speech', 'bigasr-flash'],
      ['system-speech', 'system-speech'],
    ] as Array<[string, string]>) {
      expect(resolveStreamingAsrProtocol(provider, id)).toBe('');
    }
  });

  it('批式那条老规则不受影响（qwen3-asr-flash 仍然归批式协议）', () => {
    expect(inferMediaProtocolId('dashscope', 'speechRecognition', 'qwen3-asr-flash')).toBe('dashscope-qwen-asr-chat');
  });

  it('能力键的别名都归一到同一个 key', () => {
    for (const alias of ['speech_recognition_streaming', 'speechRecognitionStreaming', 'asr_realtime', 'asrRealtime']) {
      expect(inferMediaProtocolId('dashscope', alias, 'paraformer-realtime-v2')).toBe(REALTIME_PROTOCOL);
    }
  });
});
