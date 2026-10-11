// 语音输入（实时流式）的引擎注册表 + 能力声明。
//
// 注意「语音输入」和「语音条转录」是两条独立链路：
//   · 语音条转录：整段音频上传云端转文字，走 adapters.ts（OpenAI / MiMo 等），
//     由 SpeechRecognitionService.transcribeVoiceAttachment 驱动；
//   · 语音输入：按住麦克风边说边出字，走 sidecar（本地 sherpa-onnx）或云端流式
//     （百炼 paraformer-realtime），由前端 asr-stream.ts 驱动。
// 这里注册的是后者。

export interface InputEngineCapabilities {
  /** 有没有 partial 流式回调（决定要不要"预览层 + 文档层"两层结构） */
  streaming: boolean;
  /** 引擎自带标点吗（不自带才在 sidecar 补标点模型） */
  punctuation: boolean;
  /** 引擎自带数字规整吗（不自带才补中文数字转阿拉伯数字） */
  itn: boolean;
  /** 支持的语言 */
  languages: string[];
}

export interface InputEngine {
  id: string;
  label: string;
  capabilities: InputEngineCapabilities;
}

import { getLocalModelSpec } from './local-models.ts';

export interface LocalAsrModel {
  id: string;
  label: string;
  /** sidecar models/ 下的目录名，服务端拉起 sidecar 时用 */
  dir: string;
}

/**
 * 本地识别模型的**展示信息**。
 *
 * dir 不在这里重复写一份 —— 目录名由 local-models.ts 的清单统一持有。
 * 两处各写一份迟早漂移（改了一处、另一处还是老名字，sidecar 就找不到模型了）。
 */
export const LOCAL_ASR_MODELS: LocalAsrModel[] = [
  { id: 'zh-14M', label: '中文 14M（默认，最快）' },
  { id: 'bilingual', label: '中英双语' },
].map((model) => ({ ...model, dir: getLocalModelSpec(model.id)?.dir ?? model.id }));


export const DEFAULT_LOCAL_MODEL_ID = 'zh-14M';

export const INPUT_ENGINES: InputEngine[] = [
  {
    id: 'local',
    label: '本地（免费、不联网）',
    // sidecar 里这两件事都做了（标点走离线标点模型、数字规整走 itn-zh.mjs）。
    // 声明成 false 会让前端按「没有标点 / 没有规整」去渲染和处理 —— 与实际能力不符。
    capabilities: { streaming: true, punctuation: true, itn: true, languages: ['zh', 'en'] },
  },
  {
    id: 'cloud',
    // 三个引擎的 label 刻意对仗：本地 / 云端流式 / 云端批式
    label: '云端流式（边说边出字）',
    capabilities: { streaming: true, punctuation: true, itn: true, languages: ['zh', 'en'] },
  },
  {
    id: 'cloud-batch',
    // 走作者已有的「语音条转录」通道：录音 → 上传成会话文件 → 云端转写 → 一次性出字。
    // 云端模型的选择完全复用作者的「语音条转录模型」设置，不需要自己再加一套下拉。
    label: '云端批式（录完一次性出字）',
    // streaming:false → 没有中间结果，"预览层/文档层"两层在这里退化成一层的效果：
    // 录音期间界面不显示草稿，松手后识别结果一次性落到光标处。
    capabilities: { streaming: false, punctuation: true, itn: true, languages: ['zh', 'en'] },
  },
];

export const DEFAULT_INPUT_ENGINE = 'local';

export function getInputEngine(id: string): InputEngine | undefined {
  return INPUT_ENGINES.find((engine) => engine.id === id);
}

export function getLocalModel(id: string): LocalAsrModel | undefined {
  return LOCAL_ASR_MODELS.find((model) => model.id === id);
}

/** 归一化引擎 id：不认识的值一律退回默认，避免配置里存了脏数据把链路卡死 */
export function normalizeInputEngine(value: unknown): string {
  return typeof value === 'string' && getInputEngine(value) ? value : DEFAULT_INPUT_ENGINE;
}

export function normalizeLocalModel(value: unknown): string {
  return typeof value === 'string' && getLocalModel(value) ? value : DEFAULT_LOCAL_MODEL_ID;
}

/**
 * 云端批式用的转写模型（{provider, id}）。
 *
 * 为什么它和作者的「语音条转录模型」(defaultModel) 分开存：
 *   两者是**不同功能** —— 作者的用于"把语音条转成聊天消息"，我们的用于"把说出来的话
 *   填进输入框"。以前我们的批式引擎直接借用 defaultModel，结果必须先打开作者的
 *   「发送语音时转录」开关、还要挑好模型才能用，耦合得很别扭（而且用户一旦关掉那个
 *   开关，我们的功能就跟着瘫）。所以单独存一份。
 *
 * provider 与 id 必须同时有，缺一视为未配置（返回 undefined），由上层提示用户去选。
 */
export function normalizeInputBatchModel(value: unknown): { provider: string; id: string } | undefined {
  return normalizeSpeechModelRef(value);
}

/**
 * 「云端流式」选中的模型（{provider, id}）。
 *
 * 与批式那份**分开存**（理由同上：不同功能不该共用一份配置）。
 * 与批式那行不同的是，这一行的候选**不是写死的**：来自供应商声明 +
 * `speechRecognitionStreaming` 能力注册表，用户在供应商里加/删模型都会实时反映。
 */
export function normalizeInputCloudModel(value: unknown): { provider: string; id: string } | undefined {
  return normalizeSpeechModelRef(value);
}

/** {provider, id} 形态的语音模型引用：两者必须同时有，缺一视为未配置 */
function normalizeSpeechModelRef(value: unknown): { provider: string; id: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const provider = typeof (value as { provider?: unknown }).provider === 'string'
    ? (value as { provider: string }).provider.trim()
    : '';
  const id = typeof (value as { id?: unknown }).id === 'string'
    ? (value as { id: string }).id.trim()
    : '';
  return provider && id ? { provider, id } : undefined;
}
