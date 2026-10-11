/**
 * media-protocols.ts — media capability 命名与 protocol 推断的唯一入口
 *
 * Provider 声明一个媒体模型存在，protocolId 决定由哪个 adapter 执行它。
 * 所有"模型缺 protocolId 时怎么补"的判定都必须走 inferMediaProtocolId()，
 * 禁止在注册处 / 迁移处 / 过滤处各自维护一份推断规则（#1627 的根因之一）。
 */

/** capability 别名 → 规范 camelCase key */
export const MEDIA_CAPABILITY_KEYS = {
  image_generation: "imageGeneration",
  image: "imageGeneration",
  video_generation: "videoGeneration",
  video: "videoGeneration",
  speech_generation: "speechGeneration",
  speech_recognition: "speechRecognition",
  speechRecognition: "speechRecognition",
  transcription: "speechRecognition",
  asr: "speechRecognition",
  // 实时（流式）语音识别：与批式**分开的能力**。
  // 批式 = 上传整段音频一次性转写（HTTP）；流式 = 边说边出字（WebSocket 双向）。
  // 两者协议/事件模型/参数都不同，混在一个能力里会让"该走哪个协议"无从判断。
  speech_recognition_streaming: "speechRecognitionStreaming",
  speechRecognitionStreaming: "speechRecognitionStreaming",
  asr_realtime: "speechRecognitionStreaming",
  asrRealtime: "speechRecognitionStreaming",
  speech: "speechGeneration",
};

/**
 * 实时（流式）ASR 的**协议注册表**：供应商 → 型号匹配规则 → 协议 id。
 *
 * 为什么做成表：实时语音识别不止一家供应商会有（百炼之外，OpenAI 有 Realtime API、
 * 火山有流式 bigasr……）。如果把这些规则写成 `if (providerId === "dashscope" && ...)`
 * 一层层堆在函数里，加一家就要动函数主体、还容易互相干扰。
 * 做成表之后，**加一家供应商 = 加一条记录**。
 *
 * ⚠️ 但这里只决定"模型归到哪个协议"（即能不能出现在选择列表里）。
 * 一个协议要真正能跑，还需要有对应的**执行实现**：
 * 目前只有百炼的实时协议有实现（`server/asr-cloud-forwarder.ts` 的 WebSocket 双向转发）。
 * 给别家加流式，除了在这里加一条，还要写它自己的转发器 —— 否则用户选得到、但一按录音就失败。
 *
 * match / exclude 用正则按"族"匹配，不写死具体型号：型号常带日期后缀
 * （如 fun-asr-realtime-2026-02-28），写死会漏掉变体。
 */
const STREAMING_ASR_PROTOCOLS = [
  {
    providerId: "dashscope",
    protocolId: "dashscope-paraformer-realtime",
    // 与转发器依赖的事件结构（payload.output.sentence.text / .sentence_end）同构的族：
    // paraformer-realtime-*、fun-asr-realtime*、qwen-audio-*-asr-flash-streaming
    match: /(^|-)paraformer-realtime|^fun-asr-realtime|asr-flash-streaming/,
    // 同属"实时"但**协议不同**，转发器认不了，显式排除（避免用户选到跑不通的型号）：
    //   · qwen3-asr-flash-realtime / qwen3.5-omni-*-realtime —— 会话式协议，
    //     事件名是 conversation.item.*，与 payload.output.sentence 完全不同；
    //   · paraformer-realtime-8k-v2 —— 只接受 8k 采样，前端推的是 16k（需重采样）。
    exclude: /^qwen3-asr-flash-realtime$|^qwen3\.5-omni-.*-realtime$|-8k-/,
  },
];

export function resolveStreamingAsrProtocol(providerId, modelId) {
  const id = String(modelId || "");
  for (const entry of STREAMING_ASR_PROTOCOLS) {
    if (entry.providerId !== providerId) continue;
    if (entry.exclude?.test(id)) return "";
    if (entry.match.test(id)) return entry.protocolId;
  }
  return "";
}

/** 当前**有执行实现**的流式协议。列表外的协议即使被声明，也跑不起来。 */
export const IMPLEMENTED_STREAMING_ASR_PROTOCOLS = new Set([
  "dashscope-paraformer-realtime",
]);

export function capabilityKey(capability) {
  return MEDIA_CAPABILITY_KEYS[capability] || capability;
}

/**
 * 自定义 provider 中视为"OpenAI 兼容网关"的 api 协议。
 * 这类网关约定俗成在同一 base_url 下提供 OpenAI Images API（/images/generations）。
 */
const OPENAI_COMPATIBLE_APIS = new Set(["openai-completions", "openai-responses"]);

/**
 * 推断媒体模型的 protocolId。
 *
 * @param {string} providerId
 * @param {string} capability - 支持 snake/camel 别名（见 MEDIA_CAPABILITY_KEYS）
 * @param {string} modelId
 * @param {{ api?: string, sourceKind?: string }} [provider] - provider 上下文：
 *   - api: provider 生效的 API 协议（ProviderEntry.api）
 *   - sourceKind: provider 来源（"builtin" | "plugin" | "user"）；"user" 表示
 *     added-models.yaml 里用户自定义、无插件声明的 provider。
 *   调用方掌握多少上下文就传多少：迁移层不知道来源时不传，
 *   依赖来源的规则（自定义 provider → openai-images）就不会触发。
 * @returns {string} 推断出的 protocolId；无法判定时返回 ""（调用方必须显式处理，不允许静默丢弃）
 */
export function inferMediaProtocolId(providerId, capability, modelId, provider: { api?: string; sourceKind?: string } = {}) {
  const key = capabilityKey(capability);
  const id = String(modelId || "");

  if (key === "imageGeneration") {
    // 内置 provider 的显式规则
    if (providerId === "openai-codex-oauth") return "openai-codex-responses-image";
    if (providerId === "openai" && (id.startsWith("gpt-image") || id.startsWith("dall-e"))) return "openai-images";
    if (providerId === "volcengine" && id.includes("seedream")) return "volcengine-images";
    if (providerId === "dashscope" && id.startsWith("wan")) return "dashscope-wan-images";
    if (providerId === "dashscope" && id.startsWith("qwen-image-2")) return "dashscope-qwen-multimodal-image";
    if (providerId === "dashscope" && id.startsWith("qwen-image")) return "dashscope-qwen-text2image";
    if (providerId === "minimax" && id.startsWith("image-")) return "minimax-images";
    if (providerId === "gemini" && id.includes("image")) return "gemini-generate-content-image";
    // 用户自定义 provider：OpenAI 兼容网关的图片模型按 OpenAI Images API 执行（#1627）。
    // 仅对 sourceKind === "user" 生效，内置 / 插件 provider 行为不变。
    if (provider.sourceKind === "user" && OPENAI_COMPATIBLE_APIS.has(provider.api)) return "openai-images";
    return "";
  }

  if (key === "speechRecognition") {
    if (providerId === "openai" && (id.includes("transcribe") || id === "whisper-1")) return "openai-audio-transcriptions";
    if ((providerId === "mimo" || providerId === "mimo-token-plan") && id.includes("asr")) return "mimo-chat-completions-asr";
    if (providerId === "dashscope" && id.includes("asr")) return "dashscope-qwen-asr-chat";
    if (providerId === "volcengine-speech" && id.includes("bigasr")) return "volcengine-bigasr-transcription";
    if (providerId === "system-speech") return "system-speech-recognition";
    return "";
  }

  if (key === "speechRecognitionStreaming") {
    // 规则见上面的 STREAMING_ASR_PROTOCOLS（表驱动，加一家供应商只加一条）。
    // 返回 "" 表示"这个模型没有可用协议" → 它不会出现在任何能力的选择列表里，
    // 用户也就不会选到一个注定跑不通的型号。
    return resolveStreamingAsrProtocol(providerId, id);
  }

  return "";
}
