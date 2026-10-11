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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inferMediaProtocolId, resolveStreamingAsrProtocol } from '../core/media-protocols.ts';

// ── 转发器（百炼 WS 转发）单测用的假 ws ──
// 用**假的 ws 模块**模拟上游：不接触真实 API Key、也不真的连网。
// 覆盖三件事：握手期音频不丢（C1a）、final 不再带会粘连英文单词的 text（C1c）、
// WS 地址可被环境变量覆盖（C4）。
const wsMock = vi.hoisted(() => ({
  upstreams: [] as Array<{ ws: any; url: string }>,
  clients: [] as any[],
  reset() {
    this.upstreams.length = 0;
    this.clients.length = 0;
  },
}));

vi.mock('ws', () => {
  const OPEN = 1;
  const CONNECTING = 0;
  const CLOSED = 3;
  class FakeWebSocket {
    readyState = CONNECTING;
    OPEN = OPEN;
    CONNECTING = CONNECTING;
    CLOSED = CLOSED;
    handlers: Record<string, Array<(...args: any[]) => void>> = {};
    sent: any[] = [];
    constructor(url?: string) {
      // 转发器只用 `new WebSocket(...)` 创建**上游**连接，所以构造出来的都是上游
      wsMock.upstreams.push({ ws: this, url: String(url ?? '') });
    }
    on(event: string, cb: (...args: any[]) => void) {
      (this.handlers[event] ||= []).push(cb);
      return this;
    }
    send(data: any) { this.sent.push(data); }
    close() { this.readyState = CLOSED; }
    emit(event: string, ...args: any[]) {
      for (const cb of this.handlers[event] || []) cb(...args);
    }
  }
  class FakeWebSocketServer {
    handleUpgrade(_req: any, _socket: any, _head: any, cb: (ws: any) => void) {
      // 客户端这条 ws 由"升级成功回调"交给转发器，不走 new WebSocket，因此不记进 upstreams
      const client = Object.create(FakeWebSocket.prototype) as any;
      client.readyState = OPEN;
      client.OPEN = OPEN;
      client.handlers = {};
      client.sent = [];
      wsMock.clients.push(client);
      cb(client);
    }
  }
  return { WebSocket: FakeWebSocket, WebSocketServer: FakeWebSocketServer };
});

import { createAsrCloudForwarder } from '../server/asr-cloud-forwarder.ts';

function makeUpgradeReq(url = '/api/asr/cloud?model=paraformer-realtime-v2') {
  return { url, headers: { host: '127.0.0.1' } };
}

/** 建一个转发器并让它"连上"一个假客户端，返回可手动驱动的两端 */
function openForwarder() {
  createAsrCloudForwarder({ getApiKey: () => 'test-key' }).handleUpgrade(makeUpgradeReq(), {}, null);
  return { client: wsMock.clients.at(-1), upstream: wsMock.upstreams.at(-1)!.ws };
}

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

describe('百炼实时语音转发器（用模拟上游，不碰真实 API Key）', () => {
  beforeEach(() => {
    wsMock.reset();
    delete process.env.HANA_DASHSCOPE_WS_URL;
  });

  it('上游还在 CONNECTING 时到达的音频不会丢，握手完成后按序补发（C1a）', () => {
    const { client, upstream } = openForwarder();
    // 上游还没 OPEN，客户端已经开始推流了 —— 以前这里会被直接丢弃，开头的字凭空消失
    client.emit('message', Buffer.from([1, 2]), true);
    client.emit('message', Buffer.from([3, 4]), true);
    expect(upstream.sent).toHaveLength(0);   // 还没握手，什么都不该往上写

    // 上游握手完成 + run-task 被应答
    upstream.readyState = upstream.OPEN;
    upstream.emit('open');
    upstream.emit('message', JSON.stringify({ header: { event: 'task-started' } }), false);

    // 补发，顺序与原推入一致
    const binary = () => upstream.sent.filter((d: unknown) => Buffer.isBuffer(d)).map((b: Buffer) => Array.from(b));
    expect(binary()).toEqual([[1, 2], [3, 4]]);

    // 之后的音频直接透传，没有回归成"全攒着"
    client.emit('message', Buffer.from([5]), true);
    expect(binary()).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('final 只带 pending，不再带会粘连英文单词的 text/segments（C1c）', () => {
    const { client, upstream } = openForwarder();
    upstream.readyState = upstream.OPEN;
    upstream.emit('open');
    upstream.emit('message', JSON.stringify({ header: { event: 'task-started' } }), false);

    // 两个句末片段：老实现用 segments.join("") 会拼成 "helloworld"
    for (const text of ['hello', 'world']) {
      upstream.emit('message', JSON.stringify({
        header: { event: 'result-generated' },
        payload: { output: { sentence: { text, sentence_end: true } } },
      }), false);
    }
    upstream.emit('message', JSON.stringify({ header: { event: 'task-finished' } }), false);

    const finals = client.sent
      .map((d: unknown) => JSON.parse(String(d)))
      .filter((m: any) => m?.type === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0]).toEqual({ type: 'final', pending: '' });
    expect(finals[0]).not.toHaveProperty('text');
    expect(finals[0]).not.toHaveProperty('segments');
  });

  // 把上游发出的一串数据里所有 finish-task 挑出来（便于断言"发了几次、字段对不对"）
  const finishTasksOf = (upstream: any) => upstream.sent
    .filter((d: unknown) => typeof d === 'string')
    .map((d: string) => JSON.parse(d))
    .filter((m: any) => m?.header?.action === 'finish-task');

  it('end 早于 task-started：先记不发，等 task-started 后才补发 finish-task，且只发一次（C1b-1）', () => {
    const { client, upstream } = openForwarder();
    // 上游已 OPEN、run-task 也发出去了，但 task-started 还没回来 —— 客户端这时就收尾了
    upstream.readyState = upstream.OPEN;
    upstream.emit('open');
    client.emit('message', Buffer.from([1, 2]), true);
    client.emit('message', JSON.stringify({ type: 'end' }), false);

    // run-task 被应答之前绝不能抢跑 finish-task（百炼会判 task-failed）
    expect(finishTasksOf(upstream)).toHaveLength(0);

    // 假上游补发 task-started：应先补发 pending 音频，再补发 finish-task
    upstream.emit('message', JSON.stringify({ header: { event: 'task-started' } }), false);
    const binary = () => upstream.sent.filter((d: unknown) => Buffer.isBuffer(d)).map((b: Buffer) => Array.from(b));
    expect(binary()).toEqual([[1, 2]]);   // 握手期攒的音频没丢

    const finish = finishTasksOf(upstream);
    expect(finish).toHaveLength(1);
    // 协议必需字段一个都不能少（task_id / streaming / payload.input）
    expect(finish[0].header.task_id).toBeTruthy();
    expect(finish[0].header.streaming).toBe('duplex');
    expect(finish[0].payload).toEqual({ input: {} });

    // 重复/乱序再来一次 task-started 也不会重复发
    upstream.emit('message', JSON.stringify({ header: { event: 'task-started' } }), false);
    expect(finishTasksOf(upstream)).toHaveLength(1);
  });

  it('end 到达时上游还在 CONNECTING：不丢，open + task-started 后仍会补发 finish-task（C1b-2）', () => {
    const { client, upstream } = openForwarder();
    // 上游还没 OPEN，客户端就连推带收尾了 —— 这是老实现把 end 静默丢掉的场景
    client.emit('message', Buffer.from([9]), true);
    client.emit('message', JSON.stringify({ type: 'end' }), false);
    expect(upstream.sent).toHaveLength(0);   // 连接都没建好，什么都不该发

    upstream.readyState = upstream.OPEN;
    upstream.emit('open');
    upstream.emit('message', JSON.stringify({ header: { event: 'task-started' } }), false);

    const binary = upstream.sent.filter((d: unknown) => Buffer.isBuffer(d)).map((b: Buffer) => Array.from(b));
    expect(binary).toEqual([[9]]);           // end 没把音频丢掉
    expect(finishTasksOf(upstream)).toHaveLength(1);
  });

  it('WS 地址默认走百炼官方端点，可用 HANA_DASHSCOPE_WS_URL 覆盖（C4）', async () => {
    vi.resetModules();
    const modDefault = await import('../server/asr-cloud-forwarder.ts');
    modDefault.createAsrCloudForwarder({ getApiKey: () => 'k' }).handleUpgrade(makeUpgradeReq(), {}, null);
    expect(wsMock.upstreams.at(-1)!.url).toBe('wss://dashscope.aliyuncs.com/api-ws/v1/inference');

    vi.resetModules();
    process.env.HANA_DASHSCOPE_WS_URL = 'wss://example.test/asr';
    const modOverride = await import('../server/asr-cloud-forwarder.ts');
    modOverride.createAsrCloudForwarder({ getApiKey: () => 'k' }).handleUpgrade(makeUpgradeReq(), {}, null);
    expect(wsMock.upstreams.at(-1)!.url).toBe('wss://example.test/asr');
  });
});
