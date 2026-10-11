/**
 * DashScope provider plugin
 *
 * 阿里云百炼 OpenAI 兼容接口，承载 Qwen、MiniMax（通过 DashScope 转发）、
 * GLM、Kimi、SiliconFlow 等众多模型。
 *
 * 文档：https://help.aliyun.com/zh/model-studio/developer-reference/use-qwen-by-calling-api
 */

import {
  COMMON_IMAGE_RATIOS,
  booleanParam,
  enumParam,
  integerParam,
  mediaMode,
  noReferenceImages,
  referenceImages,
  stringParam,
} from "./media-schema-helpers.ts";

const WAN_DEFAULT_RATIO = "3:2";
const QWEN_IMAGE_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16"];
const QWEN_DEFAULT_RATIO = "4:3";

function wanProperties(resolutions) {
  return {
    ratio: enumParam(COMMON_IMAGE_RATIOS, WAN_DEFAULT_RATIO),
    resolution: enumParam(resolutions, resolutions[resolutions.length - 1]),
    n: integerParam({ minimum: 1, maximum: 4, defaultValue: 1 }),
    negative_prompt: stringParam(),
    prompt_extend: booleanParam(true),
    watermark: booleanParam(false),
    seed: integerParam({ minimum: 0, maximum: 2147483647 }),
  };
}

function wanDefaults(resolutions) {
  return {
    ratio: WAN_DEFAULT_RATIO,
    resolution: resolutions[resolutions.length - 1],
  };
}

const QWEN_20_PROPERTIES = {
  ratio: enumParam(QWEN_IMAGE_RATIOS, QWEN_DEFAULT_RATIO),
  resolution: enumParam(["2K"], "2K"),
  n: integerParam({ minimum: 1, maximum: 6, defaultValue: 1 }),
  negative_prompt: stringParam(),
  prompt_extend: booleanParam(true),
  watermark: booleanParam(false),
  seed: integerParam({ minimum: 0, maximum: 2147483647 }),
};

const QWEN_TEXT_PROPERTIES = {
  ratio: enumParam(QWEN_IMAGE_RATIOS, QWEN_DEFAULT_RATIO),
  resolution: enumParam(["1K"], "1K"),
  n: integerParam({ minimum: 1, maximum: 1, defaultValue: 1 }),
  negative_prompt: stringParam(),
  prompt_extend: booleanParam(true),
  watermark: booleanParam(false),
  seed: integerParam({ minimum: 0, maximum: 2147483647 }),
};

const QWEN_20_DEFAULTS = { ratio: QWEN_DEFAULT_RATIO, resolution: "2K" };
const QWEN_TEXT_DEFAULTS = { ratio: QWEN_DEFAULT_RATIO, resolution: "1K" };

function wanModel(id, displayName, aliases, textResolutions, referenceResolutions) {
  const textProperties = wanProperties(textResolutions);
  const referenceProperties = wanProperties(referenceResolutions);
  return {
    id,
    displayName,
    protocolId: "dashscope-wan-images",
    inputs: ["text", "image"],
    outputs: ["image"],
    supportsEdit: true,
    aliases,
    modes: [
      mediaMode("text2image", "Text to image", textProperties, wanDefaults(textResolutions), noReferenceImages()),
      mediaMode("image2image", "Image/reference to image", referenceProperties, wanDefaults(referenceResolutions), referenceImages()),
    ],
    ratios: [...COMMON_IMAGE_RATIOS],
    resolutions: [...new Set([...textResolutions, ...referenceResolutions])],
  };
}

function qwen20Model(id, displayName, aliases) {
  return {
    id,
    displayName,
    protocolId: "dashscope-qwen-multimodal-image",
    inputs: ["text", "image"],
    outputs: ["image"],
    supportsEdit: true,
    aliases,
    modes: [
      mediaMode("text2image", "Text to image", QWEN_20_PROPERTIES, QWEN_20_DEFAULTS, noReferenceImages()),
      mediaMode("image2image", "Image edit/reference", QWEN_20_PROPERTIES, QWEN_20_DEFAULTS, referenceImages()),
    ],
    ratios: QWEN_IMAGE_RATIOS,
    resolutions: ["2K"],
  };
}

function qwenTextModel(id, displayName, aliases = undefined) {
  return {
    id,
    displayName,
    protocolId: "dashscope-qwen-text2image",
    inputs: ["text"],
    outputs: ["image"],
    ...(aliases ? { aliases } : {}),
    modes: [
      mediaMode("text2image", "Text to image", QWEN_TEXT_PROPERTIES, QWEN_TEXT_DEFAULTS, noReferenceImages()),
    ],
    ratios: QWEN_IMAGE_RATIOS,
    resolutions: ["1K"],
  };
}

/** @type {import('../provider-registry.ts').ProviderPlugin} */
export const dashscopePlugin = {
  id: "dashscope",
  displayName: "阿里云百炼 (DashScope)",
  authType: "api-key",
  defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  defaultApi: "openai-completions",
  capabilities: {
    media: {
      imageGeneration: {
        defaultModelId: "wan2.7-image-pro",
        models: [
          wanModel("wan2.7-image-pro", "Wan 2.7 Image Pro", ["wan-2.7-pro"], ["1K", "2K", "4K"], ["1K", "2K"]),
          wanModel("wan2.7-image", "Wan 2.7 Image", ["wan-2.7"], ["1K", "2K"], ["1K", "2K"]),
          qwen20Model("qwen-image-2.0-pro", "Qwen Image 2.0 Pro", ["qwen-image-pro"]),
          qwenTextModel("qwen-image-plus", "Qwen Image Plus", ["qwen-image"]),
          qwenTextModel("qwen-image", "Qwen Image"),
        ],
      },
      speechRecognition: {
        defaultModelId: "qwen3-asr-flash",
        models: [
          { id: "qwen3-asr-flash", displayName: "Qwen3 ASR Flash", protocolId: "dashscope-qwen-asr-chat", inputs: ["audio"], outputs: ["text"] },
        ],
      },
      // 实时（流式）语音识别 —— 与上面的 speechRecognition（批式）是**两种能力**：
      // 批式是 HTTP 一次性上传整段音频，流式是 WebSocket 双向收发。
      // 协议、事件模型、参数都不同，所以各自注册、各自出现在不同的选择入口。
      // 流式的实际执行在 server/asr-cloud-forwarder.ts（服务端转发，API Key 不下发渲染层）。
      //
      // 这三个型号与转发器依赖的事件结构（payload.output.sentence.text / .sentence_end）同构，
      // 可以直接用；会话式的 qwen3-asr-flash-realtime / qwen3.5-omni-*-realtime 事件名完全不同，
      // 不在 inferMediaProtocolId 的匹配范围内（会被判为无协议，因此不出现在列表里）。
      speechRecognitionStreaming: {
        defaultModelId: "paraformer-realtime-v2",
        models: [
          { id: "paraformer-realtime-v2", displayName: "Paraformer Realtime v2", protocolId: "dashscope-paraformer-realtime", inputs: ["audio"], outputs: ["text"] },
          { id: "fun-asr-realtime", displayName: "Fun-ASR Realtime", protocolId: "dashscope-paraformer-realtime", inputs: ["audio"], outputs: ["text"] },
          { id: "qwen-audio-3.0-asr-flash-streaming", displayName: "Qwen-Audio 3.0 ASR Flash Streaming", protocolId: "dashscope-paraformer-realtime", inputs: ["audio"], outputs: ["text"] },
        ],
      },
    },
  },
};
