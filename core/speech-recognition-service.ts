import { MediaAdapterRegistry } from "./media-adapter-registry.ts";
import { IMPLEMENTED_STREAMING_ASR_PROTOCOLS } from "./media-protocols.ts";
import { builtinSpeechRecognitionAdapters } from "./speech-recognition/adapters.ts";
import {
  DEFAULT_INPUT_ENGINE,
  DEFAULT_LOCAL_MODEL_ID,
  normalizeInputBatchModel,
  normalizeInputCloudModel,
  normalizeInputEngine,
  normalizeLocalModel,
} from "./speech-recognition/input-engines.ts";
import { createModuleLogger } from "../lib/debug-log.ts";

const CAPABILITY = "speech_recognition";
/**
 * 实时（流式）语音识别：与批式**分开的能力**。
 * 批式 = 上传整段音频一次性转写；流式 = 边说边出字。
 * 两者协议、事件模型、参数都不同，所以各自注册、各自出现在自己的选择入口。
 */
const STREAMING_CAPABILITY = "speech_recognition_streaming";

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSessionRef(input: any = {}) {
  const rawRef = input.sessionRef && typeof input.sessionRef === "object" ? input.sessionRef : null;
  const sessionId = textOrNull(input.sessionId) || textOrNull(rawRef?.sessionId);
  const sessionPath =
    textOrNull(input.sessionPath)
    || textOrNull(rawRef?.sessionPath)
    || textOrNull(rawRef?.path);
  const legacySessionPath =
    textOrNull(input.legacySessionPath)
    || textOrNull(rawRef?.legacySessionPath)
    || (sessionId && sessionPath ? sessionPath : null);
  const sessionRef = sessionId
    ? {
      sessionId,
      ...(sessionPath ? { sessionPath } : {}),
      ...(legacySessionPath ? { legacySessionPath } : {}),
    }
    : null;
  return { sessionId, sessionPath, sessionRef };
}
const log = createModuleLogger("speech-recognition");

export class SpeechRecognitionService {
  declare _emitEvent: any;
  declare _fetch: any;
  declare _logger: any;
  declare _prefs: any;
  declare _providers: any;
  declare _registry: any;
  declare _sessionFiles: any;
  constructor({
    providerRegistry,
    preferences,
    sessionFiles,
    emitEvent,
    fetch,
    logger = log,
    adapters = builtinSpeechRecognitionAdapters,
  }: any = {}) {
    if (!providerRegistry) throw new Error("SpeechRecognitionService requires providerRegistry");
    if (!preferences) throw new Error("SpeechRecognitionService requires preferences");
    if (!sessionFiles) throw new Error("SpeechRecognitionService requires sessionFiles");
    this._providers = providerRegistry;
    this._prefs = preferences;
    this._sessionFiles = sessionFiles;
    this._emitEvent = typeof emitEvent === "function" ? emitEvent : () => {};
    this._fetch = fetch;
    this._logger = logger;
    this._registry = new MediaAdapterRegistry();
    for (const adapter of adapters || []) this.registerAdapter(adapter);
  }

  registerAdapter(adapter) {
    this._registry.register(adapter);
  }

  unregisterAdapter(adapterId) {
    this._registry.unregister(adapterId);
  }

  hasAdapterForModel(providerId, model) {
    if (!model?.protocolId) return false;
    return Boolean(this._registry.getProtocol(model.protocolId) || this._registry.get(providerId));
  }

  listProviders() {
    const next: any = {};
    for (const provider of this._providers.getMediaProviders(CAPABILITY) || []) {
      const providerId = provider.providerId;
      const models = (provider.models || [])
        .map((model) => ({
          ...model,
          adapterAvailable: this.hasAdapterForModel(providerId, model),
        }))
        .filter((model) => model.adapterAvailable);
      if (!models.length) continue;
      const credentialStatus = this._providers.getMediaProviderCredentialStatus?.(providerId, CAPABILITY) || {};
      next[providerId] = {
        ...provider,
        ...credentialStatus,
        models,
        availableModels: models.map((model) => ({
          id: model.id,
          name: model.displayName || model.name || model.id,
        })),
      };
    }
    return {
      providers: next,
      // 流式模型单独一段返回。设置界面拿它填「识别引擎」那一行，
      // 与批式那段各走各的，互不干扰。
      streamingProviders: this.listStreamingProviders(),
      config: this.getConfig(),
    };
  }

  /**
   * 列出「实时（流式）语音识别」能力下的可用模型。
   *
   * 与批式那套**完全同构**（同一个 providerRegistry、同一份凭据状态、同样的 adapterAvailable 过滤），
   * 只是换了个能力键 —— 这就是"批式与流式各自注册"的落点：
   * 一方加模型、删凭据、禁用供应商，都不会串到另一方。
   *
   * 只保留**有执行实现**的协议：声明了协议但还没写转发器的型号，列出来用户选了也跑不通，
   * 不如不列（见 media-protocols.ts 的 IMPLEMENTED_STREAMING_ASR_PROTOCOLS）。
   */
  listStreamingProviders() {
    const next: any = {};
    for (const provider of this._providers.getMediaProviders(STREAMING_CAPABILITY) || []) {
      const providerId = provider.providerId;
      const models = (provider.models || [])
        .map((model) => ({
          ...model,
          adapterAvailable: Boolean(model.protocolId)
            && IMPLEMENTED_STREAMING_ASR_PROTOCOLS.has(model.protocolId)
            && this.hasAdapterForModel(providerId, model),
        }))
        .filter((model) => model.adapterAvailable);
      if (!models.length) continue;
      const credentialStatus = this._providers.getMediaProviderCredentialStatus?.(providerId, STREAMING_CAPABILITY) || {};
      next[providerId] = {
        ...provider,
        ...credentialStatus,
        models,
        availableModels: models.map((model) => ({
          id: model.id,
          name: model.displayName || model.name || model.id,
        })),
      };
    }
    return next;
  }

  /**
   * 校验"这个流式模型能不能真的跑"。
   * 服务端转发器用它挡住渲染层传来的任意 model 值：不在可用列表里的一律拒绝。
   */
  isRunnableStreamingModel(providerId: any, modelId: any) {
    if (!providerId || !modelId) return false;
    const providers = this.listStreamingProviders();
    return Boolean(providers[providerId]?.models?.some((model) => model.id === modelId));
  }

  getConfig() {
    return this._prefs.getSpeechRecognitionConfig?.() || {
      enabled: false,
      inputEnabled: true,
      inputEngine: DEFAULT_INPUT_ENGINE,
      inputLocalModel: DEFAULT_LOCAL_MODEL_ID,
    };
  }

  setConfig(patch) {
    const next = normalizeSpeechRecognitionConfigPatch(patch, this.getConfig());
    if (next.defaultModel) {
      const listed = this.listProviders().providers;
      const provider = listed[next.defaultModel.provider];
      if (!provider?.models?.some((model) => model.id === next.defaultModel.id)) {
        throw new Error("speech recognition default model is unavailable");
      }
    }
    return this._prefs.setSpeechRecognitionConfig?.(next) || next;
  }

  async queueVoiceTranscription({ sessionId, sessionPath, sessionRef, fileId, language }: any = {}) {
    Promise.resolve()
      .then(() => this.transcribeVoiceAttachment({ sessionId, sessionPath, sessionRef, fileId, language }))
      .catch((err) => {
        this._logger?.warn?.(`voice transcription queue failed for ${fileId || "(missing fileId)"}: ${err?.message || err}`);
      });
  }

  async transcribeAudio(payload: any = {}) {
    const {
      fileId,
      language,
      providerId,
      provider,
      modelId,
      model,
    } = payload;
    const sessionTarget = normalizeSessionRef(payload);
    const { sessionId, sessionPath, sessionRef } = sessionTarget;
    if ((!sessionId && !sessionPath) || !fileId) {
      throw new Error("sessionId or sessionPath and fileId are required for audio transcription");
    }

    const file = this._sessionFiles.get(fileId, { sessionId, sessionPath });
    if (!file) throw new Error(`session file not found: ${fileId}`);

    const providerRef = providerId || provider || null;
    const modelRef = modelId || model || null;
    const config = this.getConfig();
    const defaultModel = config.defaultModel || null;
    const targetProvider = providerRef || defaultModel?.provider || null;
    const targetModel = modelRef || defaultModel?.id || null;
    if (!targetProvider || !targetModel) {
      throw new Error("speech recognition model is not configured");
    }

    const target = this._providers.resolveMediaModel({
      providerId: targetProvider,
      modelId: targetModel,
      capability: CAPABILITY,
    });
    const adapter = this._registry.getProtocol(target.model.protocolId) || this._registry.get(target.providerId);
    if (!adapter?.transcribe) throw new Error(`No speech recognition adapter registered for protocol "${target.model.protocolId}"`);

    const pending = this._updateTranscription({ sessionId, sessionPath }, fileId, {
      status: "pending",
      providerId: target.providerId,
      modelId: target.model.id,
      protocolId: target.model.protocolId,
      ...(language ? { language } : {}),
    });
    this._emitTranscriptionUpdate({ sessionId, sessionPath, sessionRef }, fileId, pending.transcription);

    try {
      const credentialProviderId = target.credentialLane?.providerId || target.providerId;
      const credentials = this._providers.getCredentials(credentialProviderId) || {};
      const result = await adapter.transcribe({
        file,
        provider: target.provider,
        model: target.model,
        credentials,
        language,
        fetch: this._fetch,
      });
      const ready = this._updateTranscription({ sessionId, sessionPath }, fileId, {
        status: "ready",
        text: result.text || "",
        providerId: target.providerId,
        modelId: target.model.id,
        protocolId: target.model.protocolId,
        ...(result.language ? { language: result.language } : language ? { language } : {}),
        ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      });
      this._emitTranscriptionUpdate({ sessionId, sessionPath, sessionRef }, fileId, ready.transcription);
      return ready.transcription;
    } catch (err) {
      const failed = this._updateTranscription({ sessionId, sessionPath }, fileId, {
        status: "failed",
        providerId: target.providerId,
        modelId: target.model.id,
        protocolId: target.model.protocolId,
        ...(language ? { language } : {}),
        error: err?.message || String(err),
      });
      this._emitTranscriptionUpdate({ sessionId, sessionPath, sessionRef }, fileId, failed.transcription);
      return failed.transcription;
    }
  }

  async transcribeVoiceAttachment(payload: any = {}) {
    const { fileId, language } = payload;
    const sessionTarget = normalizeSessionRef(payload);
    const { sessionId, sessionPath, sessionRef } = sessionTarget;
    const config = this.getConfig();
    if (!config.enabled || !config.defaultModel) return { status: "skipped", reason: "disabled" };
    if ((!sessionId && !sessionPath) || !fileId) {
      throw new Error("sessionId or sessionPath and fileId are required for voice transcription");
    }

    const file = this._sessionFiles.get(fileId, { sessionId, sessionPath });
    if (!file) throw new Error(`session file not found: ${fileId}`);
    if (file.presentation !== "voice-input") return { status: "skipped", reason: "not_voice_input" };

    const target = this._providers.resolveMediaModel({
      providerId: config.defaultModel.provider,
      modelId: config.defaultModel.id,
      capability: CAPABILITY,
    });
    const adapter = this._registry.getProtocol(target.model.protocolId) || this._registry.get(target.providerId);
    if (!adapter?.transcribe) throw new Error(`No speech recognition adapter registered for protocol "${target.model.protocolId}"`);

    const pending = this._updateTranscription({ sessionId, sessionPath }, fileId, {
      status: "pending",
      providerId: target.providerId,
      modelId: target.model.id,
      protocolId: target.model.protocolId,
      ...(language ? { language } : {}),
    });
    this._emitTranscriptionUpdate({ sessionId, sessionPath, sessionRef }, fileId, pending.transcription);

    try {
      const credentialProviderId = target.credentialLane?.providerId || target.providerId;
      const credentials = this._providers.getCredentials(credentialProviderId) || {};
      const result = await adapter.transcribe({
        file,
        provider: target.provider,
        model: target.model,
        credentials,
        language,
        fetch: this._fetch,
      });
      const ready = this._updateTranscription({ sessionId, sessionPath }, fileId, {
        status: "ready",
        text: result.text || "",
        providerId: target.providerId,
        modelId: target.model.id,
        protocolId: target.model.protocolId,
        ...(result.language ? { language: result.language } : language ? { language } : {}),
        ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      });
      this._emitTranscriptionUpdate({ sessionId, sessionPath, sessionRef }, fileId, ready.transcription);
      return ready.transcription;
    } catch (err) {
      const failed = this._updateTranscription({ sessionId, sessionPath }, fileId, {
        status: "failed",
        providerId: target.providerId,
        modelId: target.model.id,
        protocolId: target.model.protocolId,
        ...(language ? { language } : {}),
        error: err?.message || String(err),
      });
      this._emitTranscriptionUpdate({ sessionId, sessionPath, sessionRef }, fileId, failed.transcription);
      return failed.transcription;
    }
  }

  _updateTranscription(sessionRef, fileId, transcription) {
    return this._sessionFiles.updateTranscription(fileId, transcription, sessionRef);
  }

  _emitTranscriptionUpdate(sessionRef, fileId, transcription) {
    const { sessionId, sessionPath } = normalizeSessionRef(sessionRef);
    this._emitEvent({
      type: "voice_transcription_update",
      ...(sessionId ? { sessionId } : {}),
      sessionPath,
      fileId,
      transcription,
    }, sessionPath);
  }
}

function normalizeSpeechRecognitionConfigPatch(patch, current: any = {}) {
  const body = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const next = { ...current };
  if (Object.prototype.hasOwnProperty.call(body, "enabled")) {
    next.enabled = body.enabled === true;
  }
  // 输入框语音输入开关：与语音条转录彼此独立，默认开启。
  // 注意它必须在下面两个 return 分支里都带上 —— 关掉语音条转录时不能把它一起丢掉。
  if (Object.prototype.hasOwnProperty.call(body, "inputEnabled")) {
    next.inputEnabled = body.inputEnabled !== false;
  }
  // 语音输入的引擎与本地模型：归一化，两个 return 分支都带（同上，不能因关掉转录而丢）
  if (Object.prototype.hasOwnProperty.call(body, "inputEngine")) {
    next.inputEngine = normalizeInputEngine(body.inputEngine);
  }
  if (Object.prototype.hasOwnProperty.call(body, "inputLocalModel")) {
    next.inputLocalModel = normalizeLocalModel(body.inputLocalModel);
  }
  // 云端批式自己的转写模型：与作者的 defaultModel 分开存（两者是不同功能，不能耦合）。
  // 传 null/undefined 表示清空。
  if (Object.prototype.hasOwnProperty.call(body, "inputBatchModel")) {
    const batchModel = normalizeInputBatchModel(body.inputBatchModel);
    if (batchModel) next.inputBatchModel = batchModel;
    else delete next.inputBatchModel;
  }

  // 云端流式选中的模型：同样与批式分开存
  if (Object.prototype.hasOwnProperty.call(body, "inputCloudModel")) {
    const cloudModel = normalizeInputCloudModel(body.inputCloudModel);
    if (cloudModel) next.inputCloudModel = cloudModel;
    else delete next.inputCloudModel;
  }
  if (Object.prototype.hasOwnProperty.call(body, "defaultModel")) {
    const value = body.defaultModel;
    if (value === null || value === undefined) {
      delete next.defaultModel;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const provider = typeof value.provider === "string" ? value.provider.trim() : "";
      const id = typeof value.id === "string" ? value.id.trim() : "";
      if (!provider || !id) throw new Error("speechRecognition.defaultModel requires provider and id");
      next.defaultModel = { provider, id };
    } else {
      throw new Error("speechRecognition.defaultModel must be an object");
    }
  }
  if (!next.enabled) {
    return {
      enabled: false,
      inputEnabled: next.inputEnabled !== false,
      inputEngine: normalizeInputEngine(next.inputEngine),
      inputLocalModel: normalizeLocalModel(next.inputLocalModel),
      ...(next.inputBatchModel ? { inputBatchModel: next.inputBatchModel } : {}),
    ...(next.inputCloudModel ? { inputCloudModel: next.inputCloudModel } : {}),
      ...(next.inputCloudModel ? { inputCloudModel: next.inputCloudModel } : {}),
      ...(next.defaultModel ? { defaultModel: next.defaultModel } : {}),
    };
  }
  return {
    enabled: true,
    inputEnabled: next.inputEnabled !== false,
    inputEngine: normalizeInputEngine(next.inputEngine),
    inputLocalModel: normalizeLocalModel(next.inputLocalModel),
    ...(next.inputBatchModel ? { inputBatchModel: next.inputBatchModel } : {}),
    ...(next.inputCloudModel ? { inputCloudModel: next.inputCloudModel } : {}),
    ...(next.defaultModel ? { defaultModel: next.defaultModel } : {}),
  };
}
