/**
 * speech-input.ts — 语音输入里"服务端与渲染层都要知道"的常量
 *
 * 为什么放 shared/ 而不是 core/：渲染层不允许 import core/（那是服务端进程的地盘），
 * 而这些值**两边都要知道**。写两份就会出现"改了一处忘了另一处"。
 *
 * 注意这里**只放兜底默认值**，不放"云端流式用哪个模型" ——
 * 那件事现在由供应商声明 + 能力注册表决定（`speechRecognitionStreaming` 能力，
 * 见 core/media-protocols.ts 与 lib/providers/*.ts）。设置界面直接从服务端拿可用列表，
 * 用户在供应商里加/删模型、删 Key，列表都会跟着变。
 */

/** 云端流式（实时语音识别）所属的供应商：目前有执行实现的只有百炼 */
export const DEFAULT_CLOUD_STREAM_PROVIDER_ID = "dashscope";

/**
 * 兜底默认型号。
 *
 * ⚠️ 这**不是**一个产品概念（不是"推荐用这个"），而是"总得挑一个出来"的那一个：
 * 用户没选（那一行的空选项）或选中的已经不可用时，服务端用它接着工作。
 * 它的值来自供应商声明里该能力的 `defaultModelId`，两者保持一致。
 *
 * 另外，服务端转发器在拿不到 URL 里的 model 时（畸形请求）也用这个值兜底。
 */
export const DEFAULT_CLOUD_STREAM_MODEL_ID = "paraformer-realtime-v2";
