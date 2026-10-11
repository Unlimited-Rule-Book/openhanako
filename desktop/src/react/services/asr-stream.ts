/**
 * asr-stream.ts — 渲染层的语音识别流客户端
 *
 * 它只做一件事：把麦克风采集出来的 16kHz 单声道 PCM 分片推给本机的识别 sidecar，
 * 再把 sidecar 吐出来的 partial / endpoint / final 转成回调。
 *
 * 为什么要先 POST 一下：sidecar 是服务端按需拉起的子进程，端口由系统分配（避免撞车），
 * 所以渲染层得先问服务端"它起来了吗、在哪个端口"。
 *
 * 渲染层能直连 127.0.0.1 的另一个端口，是因为页面 CSP 里的 connect-src 本来就允许
 * ws://127.0.0.1:*（见 desktop/src/modules/connection-csp.js），不用改 CSP。
 */

import { hanaFetch } from '../hooks/use-hana-fetch';
import { useStore } from '../stores';
import { requireServerConnection } from './server-connection';

export interface AsrStreamHandlers {
  onStarted?: () => void;
  /** revision=true 表示这次改写了已输出的内容（引擎回退），前端可据此做视觉提示 */
  onPartial?: (text: string, revision: boolean, segmentId: number) => void;
  /**
   * 句末定稿。**text 是引擎处理后的版本**（已加标点、已把中文数字转成阿拉伯数字），
   * 不是原始识别结果 —— 提交进文档必须用这个，否则标点和数字规整就白做了。
   */
  onEndpoint?: (text: string, segmentId: number) => void;
  /**
   * 整轮结束。`pending` 是还没作为 endpoint 发出去的最后一段（已是处理后的文本），
   * 提交它即可。
   *
   * `text`/`segments` 只有**批式**会填（它本就不分句，一次性给出全文）；流式路径
   * 不透传这两个字段 —— 服务端不再发送它们（拼接完整文本没有消费者，而且按空串拼
   * 会把英文单词粘在一起），所以流式下它们恒为空，调用方不要依赖。
   */
  onFinal?: (payload: { text: string; segments: string[]; pending: string }) => void;
  onError?: (message: string) => void;
}

export interface AsrStreamSession {
  /** 推一片 PCM（16kHz 单声道 int16 LE） */
  sendPcm(data: ArrayBuffer): void;
  /** 正常收尾：让引擎把剩余音频解完并回 final */
  finish(): void;
  /** 立即断开，不等 final */
  abort(): void;
}

export interface AsrStreamOptions {
  /** 语音输入引擎：'local'（默认）| 'cloud' */
  engine?: string;
  /** 本地模型 id：'zh-14M'（默认）| 'bilingual'，仅 engine=local 时有效 */
  model?: string;
  /**
   * 云端**流式**选中的实时模型 {provider, id}，仅 engine=cloud 时有效。
   * 服务端会拿它去自己的可用列表里核对；不在列表里（或没传）就退回默认型号 —— 
   * 所以这里传的是"意向"，不是命令。
   */
  cloudModel?: { provider: string; id: string } | null;
}

// 必须**不早于** sidecar 的启动超时（server/asr-sidecar-manager.ts 里是 30s）：
// 首次使用要拉起进程 + 加载模型，前端若先放弃，用户看到的是「连接失败」而引擎其实马上就绪了。
// 这里留一点余量，让服务端有机会把它自己的错误（比如模型没下载）说清楚。
const CONNECT_TIMEOUT_MS = 35_000;

/** 引擎只吃 16kHz 单声道 PCM */
export const SPEECH_SAMPLE_RATE = 16000;

export async function startAsrStream(
  handlers: AsrStreamHandlers,
  options: AsrStreamOptions = {},
): Promise<AsrStreamSession> {
  // 1. 让服务端确保引擎在跑，并拿到连接信息（本地=端口，云端=转发路径）
  const res = await hanaFetch('/api/asr/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // cloudModel 只在云端**流式**下有意义：服务端会校验它是否可用，不可用/没传就退回默认型号。
    // 本地引擎用 model（本地模型目录名），云端批式根本不走这里。
    body: JSON.stringify({ engine: options.engine, model: options.model, cloudModel: options.cloudModel }),
    throwOnHttpError: false,
    timeout: CONNECT_TIMEOUT_MS,
  });
  const info = await res.json().catch(() => null);
  if (!res.ok || !info) {
    throw new Error(info?.error || '语音识别服务不可用');
  }
  if (info.engine === 'cloud') {
    // 云端引擎经服务端转发（API Key 不下发到渲染层），连服务端自己的 ws 端点
    return connectAsrWs(buildServerWsUrl(info.url || '/api/asr/cloud'), handlers);
  }
  if (!info.ready || !info.port) {
    throw new Error(info.error || '语音识别服务不可用');
  }

  // 2. 直连 sidecar
  return connectAsrWs(`ws://127.0.0.1:${info.port}`, handlers);
}

/** 把服务端相对 ws 路径拼到连接地址上，并带上鉴权 token（query 形式，服务端端点认这个）。 */
function buildServerWsUrl(path: string): string {
  const connection = requireServerConnection(useStore.getState(), 'asr ws: server not ready');
  const base = connection.wsUrl.replace(/\/+$/, '');
  const url = `${base}${path}`;
  if (!connection.token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(connection.token)}`;
}

/**
 * 连上一条识别流并返回会话。本地 sidecar 与云端转发共用同一套消息协议。
 *
 * ⚠️ 它**同步返回**：WebSocket 的握手与失败都在之后异步发生（onerror/onclose），
 * 所以"连不上"不会在这里 throw —— 只会经 handlers.onError 回调出去。调用方若想
 * 在连不上时做别的处理（比如回退本地），不能靠 try/catch 包住本函数，必须处理 onError。
 */
function connectAsrWs(wsUrl: string, handlers: AsrStreamHandlers): AsrStreamSession {
  const ws = new WebSocket(wsUrl);
  let closedByUs = false;

  const fail = (message: string) => {
    if (closedByUs) return;
    handlers.onError?.(message);
  };

  ws.onerror = () => fail('连接语音识别服务失败');
  ws.onclose = () => { if (!closedByUs) fail('语音识别服务已断开'); };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'start', sampleRate: SPEECH_SAMPLE_RATE }));
  ws.onmessage = (event) => {
    let msg: any;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    switch (msg?.type) {
      case 'started':
        handlers.onStarted?.();
        break;
      case 'partial':
        handlers.onPartial?.(String(msg.text ?? ''), msg.revision === true, Number(msg.segmentId ?? 0));
        break;
      case 'endpoint':
        handlers.onEndpoint?.(String(msg.text ?? ''), Number(msg.segmentId ?? 0));
        break;
      case 'final':
        handlers.onFinal?.({
          text: String(msg.text ?? ''),
          segments: Array.isArray(msg.segments) ? msg.segments : [],
          pending: String(msg.pending ?? ''),
        });
        break;
      case 'error':
        fail(String(msg.message || '语音识别出错'));
        break;
      default:
        break;
    }
  };

  return {
    sendPcm(data) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    finish() {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end' }));
      // 不立刻 close：还要等 final 回来。由调用方在收到 final 后调 abort()。
    },
    abort() {
      closedByUs = true;
      try { ws.close(); } catch { /* 已经关了 */ }
    },
  };
}
