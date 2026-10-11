/**
 * asr-batch.ts — 云端批式语音输入（录完一次性出字）
 *
 * 这条路不接流式引擎，而是复用作者已有的「语音条转录」通道：
 *   录音（攒 PCM）→ 松手 → 编码成 WAV → 上传成会话文件 → 调批式转写 → 文本落到光标处
 *
 * 为什么做成"假 session"（实现 AsrStreamSession 接口）：
 *   InputArea 对引擎只会做三件事 —— sendPcm / finish / abort。把整条差异收在这个对象里，
 *   上层的启动、停止、收尾、切会话、降级逻辑一行都不用改。
 *
 * 与流式路径的差别（也是能力声明里 streaming:false 的含义）：
 *   录音期间界面上没有草稿预览，识别结果在松手后一次性出现。
 */

import { hanaFetch } from '../hooks/use-hana-fetch';
import { SPEECH_SAMPLE_RATE, type AsrStreamHandlers, type AsrStreamSession } from './asr-stream';

/** 把累积的 int16 分片编成 WAV（云端要的是文件，不是裸 PCM） */
function encodeWavBlob(chunks: Int16Array[], sampleRate: number): Blob {
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const dataBytes = totalSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);                 // fmt chunk 长度
  view.setUint16(20, 1, true);                  // PCM
  view.setUint16(22, 1, true);                  // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);     // 字节率
  view.setUint16(32, 2, true);                  // block align
  view.setUint16(34, 16, true);                 // 位深
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      view.setInt16(offset, chunk[i], true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Blob → base64（去掉 data URL 前缀）。分片读，避免大数组把调用栈压爆。 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('读取录音数据失败'));
    reader.readAsDataURL(blob);
  });
}

export function createBatchAsrSession({
  sessionPath,
  handlers,
  batchModel,
  sampleRate = SPEECH_SAMPLE_RATE,
}: {
  sessionPath: string | null;
  handlers: AsrStreamHandlers;
  /** 用户为「云端批式」单独选的转写模型；没选就明确提示，不要退回作者的设置 */
  batchModel?: { provider: string; id: string } | null;
  sampleRate?: number;
}): AsrStreamSession {
  const chunks: Int16Array[] = [];
  let aborted = false;

  async function transcribe(): Promise<void> {
    if (sessionPath == null || sessionPath === '') {
      throw new Error('当前没有会话，无法使用云端批式识别');
    }
    // 显式传模型：不传的话服务端会退回作者的「语音条转录模型」，
    // 那就又变成"必须先打开作者的开关才能用"的耦合了。
    if (!batchModel?.provider || !batchModel.id) {
      throw new Error('BATCH_MODEL_NOT_CONFIGURED');
    }
    if (chunks.length === 0) {
      throw new Error('没有录到声音');
    }

    const base64Data = await blobToBase64(encodeWavBlob(chunks, sampleRate));

    // 1) 上传成会话文件，拿到 fileId（批式转写只认会话文件）
    const uploadRes = await hanaFetch('/api/upload-blob', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 不因非 2xx 直接抛：服务端会把原因放在 body 的 error 字段里，
      // 读出来给用户看比一句 "HTTP 400" 有用得多
      throwOnHttpError: false,
      body: JSON.stringify({
        sessionPath,
        base64Data,
        name: `voice-input-${Date.now()}.wav`,
        mimeType: 'audio/wav',
        // voice-input 这个 presentation 会让文件归到语音输入、且不作为附件展示在对话里
        presentation: 'voice-input',
      }),
    });
    const uploadData = await uploadRes.json().catch(() => null);
    const uploaded = uploadData?.uploads?.[0];
    const fileId = uploaded?.fileId;
    if (!fileId) {
      throw new Error(uploaded?.error || '上传录音失败');
    }

    // 2) 交给作者的批式转写通道（模型用的是设置里的「语音条转录模型」）
    const transcribeRes = await hanaFetch('/api/media/asr/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      throwOnHttpError: false,
      body: JSON.stringify({
        sessionPath,
        fileId,
        providerId: batchModel.provider,
        modelId: batchModel.id,
      }),
    });
    const transcribeData = await transcribeRes.json().catch(() => null);
    // 路由把异常包成 { error }，而 transcribeAudio 内部又会把失败包成
    // { transcription: { status:'failed', error } }，两种都要认
    const transcription = transcribeData?.transcription ?? transcribeData;
    if (transcription?.status === 'failed') {
      throw new Error(transcription?.error || '云端转写失败');
    }
    if (transcribeData?.error) throw new Error(String(transcribeData.error));
    const text = String(transcription?.text ?? '').trim();
    if (!text) throw new Error('没有识别到内容');

    if (aborted) return;
    // 一次性落文档：onEndpoint 负责插入，onFinal(pending 空) 负责收尾
    handlers.onEndpoint?.(text, 0);
    handlers.onFinal?.({ text, segments: [text], pending: '' });
  }

  return {
    sendPcm(data) {
      if (aborted) return;
      chunks.push(new Int16Array(data));
    },
    finish() {
      // finish 是同步接口（流式那边只是发个 end），这里把异步转写兜住，
      // 失败也要走 onError，让上层统一做"不丢字"的收尾。
      void transcribe().catch((err) => {
        if (aborted) return;
        handlers.onError?.(String(err?.message || err));
      });
    },
    abort() {
      aborted = true;
      chunks.length = 0;
    },
  };
}
