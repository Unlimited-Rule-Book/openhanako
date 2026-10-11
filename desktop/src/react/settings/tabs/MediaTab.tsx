import React, { useState, useCallback, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { updateSettingsSnapshot } from '../actions';
import { MediaProviderDetail } from './media/MediaProviderDetail';
import { AsrModelImport } from './media/AsrModelImport';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { SelectWidget, Toggle } from '@/ui';
import styles from '../Settings.module.css';

interface MediaProvider {
  providerId: string;
  displayName?: string;
  hasCredentials: boolean;
  unavailableReason?: string | null;
  unavailableMessage?: string | null;
  runtimeCapability?: {
    status?: string;
    error?: { code?: string; message?: string } | null;
  } | null;
  models: { id: string; name: string; protocolId?: string; adapterAvailable?: boolean }[];
  availableModels: { id: string; name: string }[];
}

interface MediaConfig {
  defaultImageModel?: { id: string; provider: string };
  defaultVideoModel?: { id: string; provider: string };
  providerDefaults?: Record<string, any>;
}

interface SpeechModel {
  id: string;
  name?: string;
  displayName?: string;
  protocolId?: string;
  adapterAvailable?: boolean;
}

interface SpeechProvider {
  providerId: string;
  displayName?: string;
  hasCredentials: boolean;
  unavailableReason?: string | null;
  models: SpeechModel[];
  availableModels?: { id: string; name: string }[];
}

interface SpeechConfig {
  enabled: boolean;
  /** 输入框语音输入开关：与语音条转录彼此独立，默认开启 */
  inputEnabled?: boolean;
  /** 语音输入引擎：local（默认）| cloud */
  inputEngine?: string;
  /** 本地模型：zh-14M（默认）| bilingual */
  inputLocalModel?: string;
  /**
   * 云端批式**专属**的转写模型。与下面的 defaultModel（作者的「语音条转录模型」）分开存：
   * 两者是不同功能，共用一份配置会导致"必须先打开作者那个开关才能用语音输入"的耦合。
   */
  inputBatchModel?: { id: string; provider: string };
  inputCloudModel?: { id: string; provider: string };
  defaultModel?: { id: string; provider: string };
}

type SpeechConfigPatch = {
  enabled?: boolean;
  inputEnabled?: boolean;
  inputEngine?: string;
  inputLocalModel?: string;
  inputBatchModel?: SpeechConfig['inputBatchModel'] | null;
  inputCloudModel?: SpeechConfig['inputCloudModel'] | null;
  defaultModel?: SpeechConfig['defaultModel'] | null;
};

type MediaSelection =
  | { kind: 'imageGeneration'; providerId: string }
  | { kind: 'videoGeneration'; providerId: string }
  | { kind: 'speechRecognition'; providerId: string };

const LOADING_SELECT_VALUE = '__loading';

function encodeConfigPatch(updates: Partial<MediaConfig>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(updates).map(([key, value]) => [key, value === undefined ? null : value]),
  );
}

function applyConfigPatch(prev: MediaConfig, updates: Partial<MediaConfig>): MediaConfig {
  const next: MediaConfig = { ...prev };
  for (const [key, value] of Object.entries(updates) as Array<[keyof MediaConfig, MediaConfig[keyof MediaConfig]]>) {
    if (value === undefined) delete next[key];
    else next[key] = value as any;
  }
  return next;
}

function encodeSpeechConfigPatch(updates: SpeechConfigPatch): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(updates).map(([key, value]) => [key, value === undefined ? null : value]),
  );
}

function applySpeechConfigPatch(prev: SpeechConfig, updates: SpeechConfigPatch): SpeechConfig {
  const next: SpeechConfig = { ...prev };
  if (typeof updates.enabled === 'boolean') next.enabled = updates.enabled;
  if (typeof updates.inputEnabled === 'boolean') next.inputEnabled = updates.inputEnabled;
  if (typeof updates.inputEngine === 'string') next.inputEngine = updates.inputEngine;
  if (typeof updates.inputLocalModel === 'string') next.inputLocalModel = updates.inputLocalModel;
  if ('inputBatchModel' in updates) {
    if (updates.inputBatchModel) next.inputBatchModel = updates.inputBatchModel;
    else delete next.inputBatchModel;
  }
  if ('inputCloudModel' in updates) {
    if (updates.inputCloudModel) next.inputCloudModel = updates.inputCloudModel;
    else delete next.inputCloudModel;
  }
  if ('defaultModel' in updates) {
    if (updates.defaultModel) next.defaultModel = updates.defaultModel;
    else delete next.defaultModel;
  }
  return next;
}

function mergeSpeechConfig(prev: SpeechConfig, incoming: any): SpeechConfig {
  const next: SpeechConfig = { ...prev };
  if (typeof incoming?.enabled === 'boolean') next.enabled = incoming.enabled;
  if (typeof incoming?.inputEnabled === 'boolean') next.inputEnabled = incoming.inputEnabled;
  if (typeof incoming?.inputEngine === 'string') next.inputEngine = incoming.inputEngine;
  if (typeof incoming?.inputLocalModel === 'string') next.inputLocalModel = incoming.inputLocalModel;
  if (incoming && Object.prototype.hasOwnProperty.call(incoming, 'inputBatchModel')) {
    if (incoming.inputBatchModel) next.inputBatchModel = incoming.inputBatchModel;
    else delete next.inputBatchModel;
  }
  if (incoming && Object.prototype.hasOwnProperty.call(incoming, 'inputCloudModel')) {
    if (incoming.inputCloudModel) next.inputCloudModel = incoming.inputCloudModel;
    else delete next.inputCloudModel;
  }
  if (incoming && Object.prototype.hasOwnProperty.call(incoming, 'defaultModel')) {
    if (incoming.defaultModel) next.defaultModel = incoming.defaultModel;
    else delete next.defaultModel;
  }
  return next;
}

function speechModelLabel(model: SpeechModel | { id: string; name: string }): string {
  return 'displayName' in model && model.displayName ? model.displayName : model.name || model.id;
}

function getRunnableSpeechModels(provider: SpeechProvider): Array<{ id: string; name: string }> {
  if (!provider.hasCredentials) return [];
  if (Array.isArray(provider.availableModels)) {
    return provider.availableModels.map(model => ({ id: model.id, name: model.name || model.id }));
  }
  return (provider.models || [])
    .filter(model => model.adapterAvailable !== false)
    .map(model => ({ id: model.id, name: speechModelLabel(model) }));
}

function textOrFallback(key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}

function SpeechProviderDetail({
  providerId,
  provider,
  config,
}: {
  providerId: string;
  provider: SpeechProvider;
  config: SpeechConfig | null;
}) {
  const runnableModels = getRunnableSpeechModels(provider);
  const isDefault = (modelId: string) =>
    config?.defaultModel?.id === modelId && config.defaultModel.provider === providerId;

  return (
    <div className={styles['pv-detail-inner']}>
      <div className={styles['pv-detail-header']}>
        <h2 className={styles['pv-detail-title']}>{provider.displayName || providerId}</h2>
      </div>

      <div className={styles['settings-credential-status']}>
        <span className={`${styles['settings-credential-dot']}${provider.hasCredentials ? ' ' + styles.on : ''}`} />
        {provider.hasCredentials ? t('settings.media.credentialOk') : t('settings.media.credentialMissing')}
      </div>

      <div className={styles['pv-models']}>
        <div className={styles['pv-fav-section']}>
          <div className={styles['pv-fav-title']}>
            {textOrFallback('settings.media.speechModels', '转录模型')}
            <span className={styles['pv-models-count']}>{runnableModels.length}</span>
          </div>
          {runnableModels.length > 0 ? (
            <div className={styles['pv-fav-list']}>
              {runnableModels.map(model => (
                <div key={model.id} className={styles['pv-fav-item']}>
                  <span className={styles['pv-fav-item-name']} title={model.id}>{model.name || model.id}</span>
                  <span className={styles['pv-fav-item-id']}>{model.id}</span>
                  {isDefault(model.id) && (
                    <span className={styles['settings-default-badge']}>
                      {t('settings.media.default')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className={styles['pv-empty']}>{t('settings.media.noProvider')}</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 本地识别模型的安装状态（对应后端 GET /api/asr/models 的 models[]） */
interface AsrModelStatus {
  id: string;
  state: 'ready' | 'missing' | 'partial';
  missingBytes: number;
  /** 还缺哪些文件（后端给，界面直接用） */
  missing: string[];
  totalBytes: number;
}

/** 下载进行态。ids 非空表示"有过一次下载"；error/cancelled 用来区分收尾原因 */
interface AsrModelDownloadState {
  ids: string[];
  received: number;
  total: number;
  sourceId: string | null;
  currentFile: string | null;
  error: string | null;
  cancelled: boolean;
}

export function MediaTab() {
  const snapshotSpeechConfig = useSettingsStore(s => s.settingsSnapshot.data?.preferences?.speechRecognition);
  const [providers, setProviders] = useState<Record<string, MediaProvider>>({});
  const [config, setConfig] = useState<MediaConfig | null>(null);
  const [imageConfigLoading, setImageConfigLoading] = useState(true);
  const [videoProviders, setVideoProviders] = useState<Record<string, MediaProvider>>({});
  const [videoConfig, setVideoConfig] = useState<MediaConfig | null>(null);
  const [videoConfigLoading, setVideoConfigLoading] = useState(true);
  const [speechProviders, setSpeechProviders] = useState<Record<string, SpeechProvider>>({});
  // 实时（流式）语音识别的可用模型：与批式那份完全分开，由服务端的
  // speechRecognitionStreaming 能力实时给出（跟着供应商凭据与用户补充的模型走）。
  const [streamingProviders, setStreamingProviders] = useState<Record<string, SpeechProvider>>({});
  const [speechConfig, setSpeechConfig] = useState<SpeechConfig | null>(() => (
    snapshotSpeechConfig ? mergeSpeechConfig({ enabled: false }, snapshotSpeechConfig) : null
  ));
  const [speechConfigLoading, setSpeechConfigLoading] = useState(() => !snapshotSpeechConfig);
  const [selected, setSelected] = useState<MediaSelection | null>(null);
  const showToast = useSettingsStore(s => s.showToast);

  // ── 本地识别模型：安装状态与下载（对应后端 /api/asr/models 一组接口）──
  const [asrModels, setAsrModels] = useState<AsrModelStatus[]>([]);
  const [asrModelsRoot, setAsrModelsRoot] = useState('');
  const [asrSources, setAsrSources] = useState<Array<{ id: string; label: string }>>([]);
  const [asrDownload, setAsrDownload] = useState<AsrModelDownloadState | null>(null);
  // 用户主动收起"待下载"提示行（点取消）；切换引擎/模型后重置，重新提示
  // 二级面板：用户点「我已有模型文件」时展开（拖拽导入）
  const [asrImportOpen, setAsrImportOpen] = useState(false);

  const loadAsrModels = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/asr/models');
      const data = await res.json();
      setAsrModels(data?.models || []);
      setAsrModelsRoot(data?.modelsRoot || '');
      setAsrSources(data?.sources || []);
      setAsrDownload(data?.download || null);
    } catch {
      // 拿不到模型状态不该打扰用户：界面会自然显示成"未安装"，用户点一下会得到真实错误
    }
  }, []);

  useEffect(() => { void loadAsrModels(); }, [loadAsrModels]);

  // 下载进行中才轮询。用 700ms 是因为进度条不需要更细，
  // 而"只有一个进度条"的规模不值得为它新开一条推送通道。
  const asrDownloadBusy = Boolean(asrDownload && asrDownload.ids.length > 0
    && !asrDownload.error && !asrDownload.cancelled);
  useEffect(() => {
    if (!asrDownloadBusy) return undefined;
    const timer = window.setInterval(() => { void loadAsrModels(); }, 700);
    return () => window.clearInterval(timer);
  }, [asrDownloadBusy, loadAsrModels]);

  useEffect(() => {
    if (!snapshotSpeechConfig) return;
    setSpeechConfig(mergeSpeechConfig({ enabled: false }, snapshotSpeechConfig));
  }, [snapshotSpeechConfig]);

  const loadImageProviders = useCallback(async () => {
    setImageConfigLoading(true);
    try {
      const res = await hanaFetch('/api/media/image/providers');
      const data = await res.json();
      const nextProviders = data.providers || {};
      setProviders(nextProviders);
      setConfig(data.config || {});
      setSelected(current => {
        if (current && current.kind !== 'imageGeneration') return current;
        if (current?.kind === 'imageGeneration' && nextProviders[current.providerId]) return current;
        const ids = Object.keys(nextProviders);
        const providerId = ids.find(id => nextProviders[id]?.hasCredentials) || ids[0] || null;
        return providerId ? { kind: 'imageGeneration', providerId } : null;
      });
    } catch {
      setProviders({});
      setConfig({});
    } finally {
      setImageConfigLoading(false);
    }
  }, []);

  const loadVideoProviders = useCallback(async () => {
    setVideoConfigLoading(true);
    try {
      const res = await hanaFetch('/api/media/video/providers');
      const data = await res.json();
      const nextProviders = data.providers || {};
      setVideoProviders(nextProviders);
      setVideoConfig(data.config || {});
      setSelected(current => {
        if (current && current.kind !== 'videoGeneration') return current;
        if (current?.kind === 'videoGeneration' && nextProviders[current.providerId]) return current;
        const ids = Object.keys(nextProviders);
        const providerId = ids.find(id => nextProviders[id]?.hasCredentials) || ids[0] || null;
        return providerId ? { kind: 'videoGeneration', providerId } : null;
      });
    } catch {
      setVideoProviders({});
      setVideoConfig({});
    } finally {
      setVideoConfigLoading(false);
    }
  }, []);

  const loadSpeechProviders = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/speech-recognition/providers');
      const data = await res.json();
      const nextProviders = data.providers || {};
      setSpeechProviders(nextProviders);
      setStreamingProviders(data.streamingProviders || {});
      setSpeechConfig(mergeSpeechConfig({ enabled: false }, data.config || {}));
      setSelected(current => {
        if (current?.kind !== 'speechRecognition') return current;
        if (nextProviders[current.providerId]) return current;
        return null;
      });
    } catch (err: any) {
      setSpeechProviders({});
      setStreamingProviders({});
      showToast(err.message || 'Failed to load speech recognition providers', 'error');
    } finally {
      setSpeechConfigLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadImageProviders();
    loadVideoProviders();
    loadSpeechProviders();
    const refreshRuntimeMediaProviders = () => {
      loadImageProviders();
      loadVideoProviders();
    };
    window.addEventListener('focus', refreshRuntimeMediaProviders);
    return () => window.removeEventListener('focus', refreshRuntimeMediaProviders);
  }, [loadImageProviders, loadVideoProviders, loadSpeechProviders]);

  const providerIds = Object.keys(providers);
  const videoProviderIds = Object.keys(videoProviders);
  const speechProviderIds = Object.keys(speechProviders);
  const allImageModels = providerIds.flatMap(pid =>
    (providers[pid].models || []).map(m => ({ ...m, provider: pid }))
  );
  const allVideoModels = videoProviderIds.flatMap(pid =>
    (videoProviders[pid].models || []).map(m => ({ ...m, provider: pid }))
  );
  const allSpeechModels = speechProviderIds.flatMap(pid =>
    getRunnableSpeechModels(speechProviders[pid]).map(m => ({ ...m, provider: pid }))
  );
  const streamingProviderIds = Object.keys(streamingProviders);
  // 注意这里**不按凭据过滤**：没有凭据的也列出来、只是置灰（见上面 inputCloudModelOptions）。
  const allStreamingModels = streamingProviderIds.flatMap(pid =>
    (streamingProviders[pid].models || []).map(m => ({
      ...m,
      provider: pid,
      usable: streamingProviders[pid].hasCredentials !== false,
    }))
  );
  const speechEnabled = speechConfig?.enabled === true;
  const voiceInputEnabled = speechConfig?.inputEnabled !== false;
  const speechRecognitionEnabledLabel = textOrFallback('settings.media.speechRecognitionEnabled', '发送语音条时转录');
  const defaultSpeechModelLabel = textOrFallback('settings.media.defaultSpeechModel', '语音条转录模型');
  const voiceInputLabel = textOrFallback('settings.media.voiceInput', '语音输入');
  const voiceInputHint = textOrFallback(
    'settings.media.voiceInputHint',
    '在输入框里把说的话实时转成文字、插入光标处。与下面的语音条转录互不影响。',
  );
  // 「识别方式」= 在哪儿跑（本地 / 云端流式 / 云端批式）；「识别引擎」= 具体用哪个模型。
  // 这么分是因为"本地/云端"描述的是方式，而用户真正关心的是"到底用的哪个模型"。
  const inputEngineLabel = textOrFallback('settings.media.inputEngine', '识别方式');
  const inputModelLabel = textOrFallback('settings.media.inputModel', '识别引擎');
  const inputEngineLocalLabel = textOrFallback('settings.media.inputEngineLocal', '本地（免费、不联网）');
  const inputEngineCloudLabel = textOrFallback('settings.media.inputEngineCloud', '云端流式（边说边出字）');
  const inputEngineCloudBatchLabel = textOrFallback('settings.media.inputEngineCloudBatch', '云端批式（录完一次性出字）');
  const localModel14MLabel = textOrFallback('settings.media.localModel14M', '中文 14M（默认，最快）');
  const localModelBilingualLabel = textOrFallback('settings.media.localModelBilingual', '中英双语');
  const inputEngineOptions = [
    { value: 'local', label: inputEngineLocalLabel },
    { value: 'cloud', label: inputEngineCloudLabel },
    { value: 'cloud-batch', label: inputEngineCloudBatchLabel },
  ];
  const localModelOptions = [
    { value: 'zh-14M', label: localModel14MLabel },
    { value: 'bilingual', label: localModelBilingualLabel },
  ];
  const inputEngineValue = speechConfig?.inputEngine || 'local';
  const inputLocalModelValue = speechConfig?.inputLocalModel || 'zh-14M';
  const inputBatchModelValue = speechConfig?.inputBatchModel
    ? `${speechConfig.inputBatchModel.provider}/${speechConfig.inputBatchModel.id}`
    : '';
  const selectedImageProviderId = selected?.kind === 'imageGeneration' ? selected.providerId : null;
  const selectedVideoProviderId = selected?.kind === 'videoGeneration' ? selected.providerId : null;
  const selectedSpeechProviderId = selected?.kind === 'speechRecognition' ? selected.providerId : null;
  const imageConfigReady = !imageConfigLoading && config !== null;
  const imageDefaultValue = imageConfigReady && config?.defaultImageModel
    ? `${config.defaultImageModel.provider}/${config.defaultImageModel.id}`
    : imageConfigReady ? '' : LOADING_SELECT_VALUE;
  const videoConfigReady = !videoConfigLoading && videoConfig !== null;
  const videoDefaultValue = videoConfigReady && videoConfig?.defaultVideoModel
    ? `${videoConfig.defaultVideoModel.provider}/${videoConfig.defaultVideoModel.id}`
    : videoConfigReady ? '' : LOADING_SELECT_VALUE;
  const speechConfigReady = !speechConfigLoading && speechConfig !== null;
  // 下拉的 value 必须落在 options 里，否则 SelectWidget 会渲染成**空白**
  // （它用 `options.find(o => o.value === value)` 取显示文本，找不到就只剩右侧箭头）。
  // 关闭「语音条转录」开关时，下面的 options 不再包含模型列表 —— 所以这里也必须
  // 让 value 退回空值（显示成“—”），否则就会出现"左边啥都没有、右边一个三角"的怪状态。
  // 注意：只是显示退回，配置里的 defaultModel 依旧保留（归一化不会因为关闭开关而清掉），
  // 因此重新打开开关时原来的模型会照常显示出来。
  const speechDefaultValue = !speechConfigReady
    ? LOADING_SELECT_VALUE
    : (speechEnabled && speechConfig?.defaultModel)
      ? `${speechConfig.defaultModel.provider}/${speechConfig.defaultModel.id}`
      : '';

  // 批式转写模型的选项：构造方式与作者的「语音条转录模型」保持一致（同一份可运行模型列表）。
  // 关键：**已经配置但不在可运行列表里的模型也要放进来**，否则 value 落不到 options 里，
  // 下拉会渲染成空白（原因见上面 speechDefaultValue 的注释）。
  const inputBatchModelOptions = [
    ...(speechConfigReady
      ? [{ value: '', label: '—' }]
      : [{ value: LOADING_SELECT_VALUE, label: t('common.loading'), disabled: true }]),
    ...(speechConfigReady && speechConfig?.inputBatchModel
      && !allSpeechModels.some(m => `${m.provider}/${m.id}` === inputBatchModelValue)
      ? [{
          value: inputBatchModelValue,
          label: `${speechConfig.inputBatchModel.provider} / ${speechConfig.inputBatchModel.id}`,
          disabled: true,
        }]
      : []),
    ...(speechConfigReady
      ? allSpeechModels.map(m => ({
          value: `${m.provider}/${m.id}`,
          label: `${m.provider} / ${m.name || m.id}`,
        }))
      : []),
  ];

  // 云端流式的候选来自服务端实时列表（供应商声明 + 用户补充的模型）。
  // 与批式那段**同构**：空选项 + "当前值不在列表里也要放进去" + 不可用（无凭据）置灰。
  // 置灰而不是消失，是为了对齐同页「默认图片模型」的做法：
  // 用户把供应商的 Key 删掉后，应当看到"这个模型现在不能用"，而不是它凭空不见了。
  const inputCloudModelValue = speechConfig?.inputCloudModel
    ? `${speechConfig.inputCloudModel.provider}/${speechConfig.inputCloudModel.id}`
    : '';
  const inputCloudModelOptions = [
    ...(speechConfigReady
      ? [{ value: '', label: '—' }]
      : [{ value: LOADING_SELECT_VALUE, label: t('common.loading'), disabled: true }]),
    ...(speechConfigReady && speechConfig?.inputCloudModel
      && !allStreamingModels.some(m => `${m.provider}/${m.id}` === inputCloudModelValue)
      ? [{
          value: inputCloudModelValue,
          label: `${speechConfig.inputCloudModel.provider} / ${speechConfig.inputCloudModel.id}`,
          disabled: true,
        }]
      : []),
    ...(speechConfigReady
      ? allStreamingModels.map(m => ({
          value: `${m.provider}/${m.id}`,
          label: `${m.provider} / ${m.name || m.id}${m.usable ? '' : `（${textOrFallback('settings.media.credentialMissing', '未配置凭据')}）`}`,
          disabled: !m.usable,
        }))
      : []),
  ];

  // ── 模型行（常驻）────────────────────────────────────────────────
  // 三种识别方式共用**同一套接口**：都是一个 SelectWidget + 一份候选列表。
  // 能不能点开选，只由"这个方式下有几个候选"决定（数据驱动），而不是写死
  // "云端流式就是固定的"。将来本地或云端流式多出几个模型，这里不用改代码就能选。
  const inputModelValue = inputEngineValue === 'cloud-batch'
    ? inputBatchModelValue
    : inputEngineValue === 'local'
      ? inputLocalModelValue
      : inputCloudModelValue;
  const inputModelOptions = inputEngineValue === 'cloud-batch'
    ? inputBatchModelOptions
    : inputEngineValue === 'local'
      ? localModelOptions
      : inputCloudModelOptions;
  const inputModelLocked = inputModelOptions.length <= 1;
  const handleInputModelChange = (val: string) => {
    if (val === LOADING_SELECT_VALUE) return;
    if (inputEngineValue === 'local') {
      if (val) saveSpeechConfig({ inputLocalModel: val });
      return;
    }
    // 云端流式与云端批式各存各的：两者是不同功能，配置也分开
    if (inputEngineValue === 'cloud') {
      if (!val) {
        saveSpeechConfig({ inputCloudModel: null });
        return;
      }
      const [provider, ...rest] = val.split('/');
      saveSpeechConfig({ inputCloudModel: { provider, id: rest.join('/') } });
      return;
    }
    if (inputEngineValue !== 'cloud-batch') return;
    if (!val) {
      saveSpeechConfig({ inputBatchModel: null });
      return;
    }
    const [provider, ...rest] = val.split('/');
    saveSpeechConfig({ inputBatchModel: { provider, id: rest.join('/') } });
  };

  // ── 本地模型的下载三态 ──
  // 判据：所选的那个本地识别模型是否就绪（标点是否就绪由后端在缺失字节里一并算给你）
  const localModelStatus = asrModels.find(m => m.id === inputLocalModelValue);
  const punctStatus = asrModels.find(m => m.id === 'punct');
  /**
   * "本地识别还缺东西吗" —— 判据必须**同时看识别模型和共享的标点模型**。
   * 只看所选识别模型会出这种怪事：中文模型补好了、标点还是半包，
   * 上面那行还写着"需要下载"，而修它的入口（导入面板）却先收起来了。
   * 这一处判据同时给"提示行"和"导入面板"用，两边不会再各算一套。
   */
  const localModelNeedsDownload = inputEngineValue === 'local' && speechConfigReady
    && ((Boolean(localModelStatus) && localModelStatus?.state !== 'ready')
      || (Boolean(punctStatus) && punctStatus?.state !== 'ready'));
  // 缺失体积 = 所选识别模型的缺口 + 标点模型的缺口（标点已装就是 0，这正是"不重复下"的体现）
  const localMissingBytes = (localModelStatus?.missingBytes || 0)
    + (punctStatus && punctStatus.state !== 'ready' ? punctStatus.missingBytes : 0);
  const formatMb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1048576))} MB`;
  /**
   * 还缺什么 —— **按模型分组**，不能拉成一个平铺列表。
   * 平铺时用户会看到「tokens.txt、model.onnx」这种，然后合理地怀疑"model.onnx 是不是多余的"：
   * 它其实是**标点模型**的文件（就是上面那行说要下载的那 281 MB），跟中文模型没关系。
   * 归属写清楚，这个清单才有意义。
   */
  const shortModelLabel = (id: string) => {
    if (id === 'punct') return t('settings.media.localModelPunctLabel');
    const label = localModelOptions.find(option => option.value === id)?.label || id;
    return label.replace(/（[^）]*）|\([^)]*\)/g, '').trim();
  };
  const localMissingGroups = asrModels
    .filter(model => (model.id === inputLocalModelValue || model.id === 'punct') && model.state !== 'ready')
    .map(model => ({ id: model.id, label: shortModelLabel(model.id), files: model.missing || [] }))
    .filter(group => group.files.length > 0);
  /**
   * 一次下载的"身份" = **它是为哪个识别模型发起的**。
   *
   * 为什么不能拿 ids 直接和"这一行关心的模型"求交集：UI 发起下载时发的 ids 是
   * `[所选识别模型, 'punct']` —— 标点是**搭车的共享件**（两种识别模型都要它），
   * 一旦把它算进身份，那么"给中英双语下载失败"就会同时命中中文这一行，
   * 于是用户切到中文后仍看到别处的失败提示（用户实测到的现象）。
   * 所以身份只取 **去掉标点之后的那些 id**。
   */
  const asrDownloadOwnerIds = (asrDownload?.ids || []).filter(id => id !== 'punct');
  const asrDownloadTouchesRow = asrDownloadOwnerIds.includes(inputLocalModelValue);
  // 下载态还额外要求"当前是本地引擎"：切到云端后即使状态残留也不显示
  const localDownloading = inputEngineValue === 'local' && asrDownloadBusy && asrDownloadTouchesRow;
  const localDownloadPercent = asrDownload && asrDownload.total > 0
    ? Math.min(100, Math.round((asrDownload.received / asrDownload.total) * 100))
    : 0;

  // "额外的那一行"：待下载 / 下载中 / 失败，三者互斥。只在本地引擎 +（模型未装好 / 下载中 / 失败）
  // 时出现，装好了整行不出现。不提供"收起"—— 不点开始下载就是不下，多一个取消只是噪声。
  /**
   * 失败提示只在**还有东西要补**的时候才有意义。
   *
   * 用户实测过这种情形：下载标点到 70% 时取消 → 自己把完整模型导入进来了 →
   * 模型已经补齐，界面上却还挂着"下载失败 / 下载已取消"。
   * 那句话在事实层面没错（那次下载确实取消了），但它已经**没有可操作性**了，
   * 继续占着位置只会让人以为"还没弄好"。
   * 所以失败态判据 = 这一行关心的模型 + 确实还缺东西 + 上次是失败/取消收场。
   */
  const asrFlowFailed = asrDownloadTouchesRow && localModelNeedsDownload
    && (Boolean(asrDownload?.error) || Boolean(asrDownload?.cancelled));
  const asrFlowVisible = inputEngineValue === 'local'
    && (localModelNeedsDownload || localDownloading);
  const asrFlowLabel = asrFlowFailed
    ? t('settings.media.localModelFailed')
    : localDownloading ? t('settings.media.localModelDownloading') : t('settings.media.localModelConfirm');
  // 当前镜像的名字：不显示出来，"换镜像"这个按钮点了就像没反应
  const asrActiveSourceLabel = asrSources.find(source => source.id === asrDownload?.sourceId)?.label || '';
  const asrFlowHint = asrFlowFailed
    ? `${asrDownload?.error || t('settings.media.localModelCancelled')}${asrActiveSourceLabel ? ` · ${asrActiveSourceLabel}` : ''}`
    : localDownloading
      ? `${asrDownload?.currentFile || ''} · ${Math.round((asrDownload?.received || 0) / 1048576)}/${Math.round((asrDownload?.total || 0) / 1048576)} MB${asrActiveSourceLabel ? ` · ${asrActiveSourceLabel}` : ''}`
      : `${t('settings.media.localModelSize')} ${formatMb(localMissingBytes)} · ${asrModelsRoot}`;

  /** 换镜像：按后端给的源顺序取"下一个"，保证点了总会有变化 */
  const nextSourceId = () => {
    if (asrSources.length < 2) return undefined;
    const current = asrDownload?.sourceId || asrSources[0].id;
    const idx = asrSources.findIndex(source => source.id === current);
    return asrSources[(idx + 1) % asrSources.length].id;
  };

  const startLocalDownload = async (sourceId?: string) => {
    try {
      // ids 传"所选识别模型 + 标点"：后端只下缺的部分，所以已装过的不会重下
      await hanaFetch('/api/asr/models/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [inputLocalModelValue, 'punct'], sourceId: sourceId ?? asrDownload?.sourceId ?? null }),
      });
      void loadAsrModels();
    } catch (err: any) {
      showToast(err?.message || t('settings.media.localModelFailed'), 'error');
    }
  };

  const cancelLocalDownload = async () => {
    try {
      await hanaFetch('/api/asr/models/cancel', { method: 'POST' });
    } finally {
      void loadAsrModels();
    }
  };


  const saveConfig = async (updates: Partial<MediaConfig>) => {
    try {
      const res = await hanaFetch('/api/media/image/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: encodeConfigPatch(updates) }),
      });
      const data = await res.json().catch(() => null);
      if (data?.values) setConfig(data.values);
      else setConfig(prev => applyConfigPatch(prev || {}, updates));
      showToast(t('settings.saved'), 'success');
    } catch (err: any) {
      showToast(err.message || 'Save failed', 'error');
    }
  };

  const saveVideoConfig = async (updates: Partial<MediaConfig>) => {
    try {
      const res = await hanaFetch('/api/media/video/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: encodeConfigPatch(updates) }),
      });
      const data = await res.json().catch(() => null);
      if (data?.values) setVideoConfig(data.values);
      else setVideoConfig(prev => applyConfigPatch(prev || {}, updates));
      showToast(t('settings.saved'), 'success');
    } catch (err: any) {
      showToast(err.message || 'Save failed', 'error');
    }
  };

  const saveSpeechConfig = async (updates: SpeechConfigPatch) => {
    try {
      const res = await hanaFetch('/api/speech-recognition/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: encodeSpeechConfigPatch(updates) }),
      });
      const data = await res.json().catch(() => null);
      setSpeechConfig(prev => {
        const base = prev || { enabled: false };
        const next = data?.config
          ? mergeSpeechConfig(base, data.config)
          : data?.values
            ? mergeSpeechConfig(base, data.values)
            : applySpeechConfigPatch(base, updates);
        updateSettingsSnapshot(snapshot => ({
          ...snapshot,
          preferences: { ...snapshot.preferences, speechRecognition: next },
        }));
        return next;
      });
      showToast(t('settings.saved'), 'success');
    } catch (err: any) {
      showToast(err.message || 'Save failed', 'error');
    }
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="media">
      {/* pv-layout：double-column variant 做外壳，内部 DOM 保留原样 */}
      <SettingsSection variant="double-column">
        <div className={styles['pv-layout']}>
          {/* Left: Provider list */}
          <div className={styles['pv-list']}>
            <div className={styles['pv-list-group-label']}>{t('settings.media.imageGeneration')}</div>
            {providerIds.map(pid => {
              const p = providers[pid];
              return (
                <button
                  key={pid}
                  className={`${styles['pv-list-item']}${selectedImageProviderId === pid ? ' ' + styles['selected'] : ''}${!p.hasCredentials ? ' ' + styles['dim'] : ''}`}
                  onClick={() => setSelected({ kind: 'imageGeneration', providerId: pid })}
                  title={p.unavailableMessage || p.unavailableReason || undefined}
                >
                  <span className={`${styles['pv-status-dot']}${p.hasCredentials ? ' ' + styles['on'] : ''}`} />
                  <span className={styles['pv-list-item-name']}>{p.displayName || pid}</span>
                  <span className={styles['pv-list-item-count']}>{p.models.length}</span>
                </button>
              );
            })}

            <div className={styles['pv-list-divider']} />
            <div className={styles['pv-list-group-label']}>{t('settings.media.videoGeneration')}</div>
            {videoProviderIds.map(pid => {
              const p = videoProviders[pid];
              return (
                <button
                  key={pid}
                  className={`${styles['pv-list-item']}${selectedVideoProviderId === pid ? ' ' + styles['selected'] : ''}${!p.hasCredentials ? ' ' + styles['dim'] : ''}`}
                  onClick={() => setSelected({ kind: 'videoGeneration', providerId: pid })}
                  title={p.unavailableMessage || p.unavailableReason || undefined}
                >
                  <span className={`${styles['pv-status-dot']}${p.hasCredentials ? ' ' + styles['on'] : ''}`} />
                  <span className={styles['pv-list-item-name']}>{p.displayName || pid}</span>
                  <span className={styles['pv-list-item-count']}>{p.models.length}</span>
                </button>
              );
            })}

            <div className={styles['pv-list-divider']} />
            <div className={styles['pv-list-group-label']}>
              {t('settings.media.speechRecognition')}
            </div>
            {speechProviderIds.map(pid => {
              const p = speechProviders[pid];
              const runnableCount = getRunnableSpeechModels(p).length;
              return (
                <button
                  key={pid}
                  type="button"
                  className={`${styles['pv-list-item']}${selectedSpeechProviderId === pid ? ' ' + styles['selected'] : ''}${!p.hasCredentials || runnableCount === 0 ? ' ' + styles['dim'] : ''}`}
                  onClick={() => setSelected({ kind: 'speechRecognition', providerId: pid })}
                  title={p.unavailableReason || undefined}
                >
                  <span className={`${styles['pv-status-dot']}${p.hasCredentials && runnableCount > 0 ? ' ' + styles['on'] : ''}`} />
                  <span className={styles['pv-list-item-name']}>{p.displayName || pid}</span>
                  <span className={styles['pv-list-item-count']}>{runnableCount}</span>
                </button>
              );
            })}

            <div className={styles['pv-list-divider']} />
            <div className={`${styles['pv-list-group-label']} ${styles['pv-list-group-label-muted']}`}>
              {t('settings.media.speechSynthesis')}
            </div>
            <div className={`${styles['pv-list-item']} ${styles['pv-list-item-disabled']}`}>
              <span className={styles['pv-status-dot']} />
              <span className={`${styles['pv-list-item-name']} ${styles['pv-list-item-coming-soon']}`}>
                {t('settings.media.comingSoon')}
              </span>
            </div>
          </div>

          {/* Right: Provider detail */}
          <div className={styles['pv-detail']}>
            {selectedImageProviderId && providers[selectedImageProviderId] ? (
              <MediaProviderDetail
                providerId={selectedImageProviderId}
                provider={providers[selectedImageProviderId]}
                capability="imageGeneration"
                config={config || {}}
                onSaveConfig={saveConfig}
                onRefresh={loadImageProviders}
              />
            ) : selectedVideoProviderId && videoProviders[selectedVideoProviderId] ? (
              <MediaProviderDetail
                providerId={selectedVideoProviderId}
                provider={videoProviders[selectedVideoProviderId]}
                capability="videoGeneration"
                config={videoConfig || {}}
                onSaveConfig={saveVideoConfig}
                onRefresh={loadVideoProviders}
              />
            ) : selectedSpeechProviderId && speechProviders[selectedSpeechProviderId] ? (
              <SpeechProviderDetail
                providerId={selectedSpeechProviderId}
                provider={speechProviders[selectedSpeechProviderId]}
                config={speechConfig}
              />
            ) : (
              <div className={styles['pv-empty']}>
                {t('settings.media.noProvider')}
              </div>
            )}
          </div>
        </div>
      </SettingsSection>

      {/* 全局默认：标准 inline row */}
      <SettingsSection title={t('settings.media.globalDefault')}>
        <SettingsRow
          label={t('settings.media.defaultModel')}
          control={
            <SelectWidget
              value={imageDefaultValue}
              onChange={(val) => {
                if (val === LOADING_SELECT_VALUE) return;
                if (!val) {
                  saveConfig({ defaultImageModel: undefined });
                  return;
                }
                const [provider, ...rest] = val.split('/');
                saveConfig({ defaultImageModel: { id: rest.join('/'), provider } });
              }}
              disabled={!imageConfigReady}
              options={[
                ...(imageConfigReady ? [{ value: '', label: '—' }] : [{ value: LOADING_SELECT_VALUE, label: t('common.loading'), disabled: true }]),
                ...(imageConfigReady && config?.defaultImageModel && !allImageModels.some(m => `${m.provider}/${m.id}` === imageDefaultValue)
                  ? [{
                      value: imageDefaultValue,
                      label: `${config.defaultImageModel.provider} / ${config.defaultImageModel.id}`,
                      disabled: true,
                    }]
                  : []),
                ...(imageConfigReady ? allImageModels.map(m => {
                  const providerHasCredentials = providers[m.provider]?.hasCredentials === true;
                  const adapterAvailable = m.adapterAvailable !== false;
                  const label = `${m.provider} / ${m.name || m.id}`;
                  const unavailableReason = !providerHasCredentials
                    ? providers[m.provider]?.unavailableMessage
                      || providers[m.provider]?.unavailableReason
                      || t('settings.media.credentialMissing')
                    : !adapterAvailable
                      ? t('settings.media.adapterMissing')
                      : '';
                  return {
                    value: `${m.provider}/${m.id}`,
                    label: unavailableReason ? `${label} (${unavailableReason})` : label,
                    disabled: !providerHasCredentials || !adapterAvailable,
                  };
                }) : []),
              ]}
            />
          }
        />
        <SettingsRow
          label={t('settings.media.defaultVideoModel')}
          control={
            <SelectWidget
              value={videoDefaultValue}
              onChange={(val) => {
                if (val === LOADING_SELECT_VALUE) return;
                if (!val) {
                  saveVideoConfig({ defaultVideoModel: undefined });
                  return;
                }
                const [provider, ...rest] = val.split('/');
                saveVideoConfig({ defaultVideoModel: { provider, id: rest.join('/') } });
              }}
              disabled={!videoConfigReady}
              options={[
                ...(videoConfigReady ? [{ value: '', label: '—' }] : [{ value: LOADING_SELECT_VALUE, label: t('common.loading'), disabled: true }]),
                ...(videoConfigReady && videoConfig?.defaultVideoModel && !allVideoModels.some(m => `${m.provider}/${m.id}` === videoDefaultValue)
                  ? [{
                      value: videoDefaultValue,
                      label: `${videoConfig.defaultVideoModel.provider} / ${videoConfig.defaultVideoModel.id}`,
                      disabled: true,
                    }]
                  : []),
                ...(videoConfigReady ? allVideoModels.map(m => {
                  const providerHasCredentials = videoProviders[m.provider]?.hasCredentials === true;
                  const adapterAvailable = m.adapterAvailable !== false;
                  const label = `${m.provider} / ${m.name || m.id}`;
                  const unavailableReason = !providerHasCredentials
                    ? videoProviders[m.provider]?.unavailableMessage
                      || videoProviders[m.provider]?.unavailableReason
                      || t('settings.media.credentialMissing')
                    : !adapterAvailable
                      ? t('settings.media.videoAdapterMissing')
                      : '';
                  return {
                    value: `${m.provider}/${m.id}`,
                    label: unavailableReason ? `${label} (${unavailableReason})` : label,
                    disabled: !providerHasCredentials || !adapterAvailable,
                  };
                }) : []),
              ]}
            />
          }
        />
        <SettingsRow
          label={speechRecognitionEnabledLabel}
          control={
            <Toggle
              ariaLabel={speechRecognitionEnabledLabel}
              on={speechConfig ? speechEnabled : undefined}
              onChange={(enabled) => saveSpeechConfig({ enabled })}
            />
          }
        />
        <SettingsRow
          label={defaultSpeechModelLabel}
          control={
            <SelectWidget
              value={speechDefaultValue}
              onChange={(val) => {
                if (val === LOADING_SELECT_VALUE) return;
                if (!val) {
                  saveSpeechConfig({ defaultModel: undefined });
                  return;
                }
                const [provider, ...rest] = val.split('/');
                saveSpeechConfig({ defaultModel: { id: rest.join('/'), provider } });
              }}
              disabled={!speechConfigReady || !speechEnabled || (allSpeechModels.length === 0 && !speechConfig?.defaultModel)}
              options={[
                ...(speechConfigReady ? [{ value: '', label: '—' }] : [{ value: LOADING_SELECT_VALUE, label: t('common.loading'), disabled: true }]),
                ...(speechConfigReady && speechConfig?.defaultModel && !allSpeechModels.some(m => `${m.provider}/${m.id}` === speechDefaultValue)
                  ? [{
                      value: speechDefaultValue,
                      label: `${speechConfig.defaultModel.provider} / ${speechConfig.defaultModel.id}`,
                      disabled: true,
                    }]
                  : []),
                ...(speechConfigReady && speechEnabled ? allSpeechModels.map(m => ({
                  value: `${m.provider}/${m.id}`,
                  label: `${m.provider} / ${m.name || m.id}`,
                })) : []),
              ]}
            />
          }
        />
        <SettingsRow
          label={voiceInputLabel}
          hint={voiceInputHint}
          layout="inline-hint"
          control={
            <Toggle
              ariaLabel={voiceInputLabel}
              on={speechConfig ? voiceInputEnabled : undefined}
              onChange={(inputEnabled) => saveSpeechConfig({ inputEnabled })}
            />
          }
        />
        <SettingsRow
          label={inputEngineLabel}
          control={
            <SelectWidget
              value={inputEngineValue}
              onChange={(val) => {
                if (val === LOADING_SELECT_VALUE) return;
                if (val) saveSpeechConfig({ inputEngine: val });
              }}
              disabled={!speechConfig || !voiceInputEnabled}
              options={inputEngineOptions}
            />
          }
        />
        {/* 模型这一行是**常驻**的，不再只在某个方式下才出现：
              · 本地 —— 可挑（14M / 中英双语）
              · 云端批式 —— 可挑（走作者那套云端模型列表）
              · 云端流式 —— 可挑（走服务端给的实时模型列表）
             这两行（识别方式 + 识别引擎）属于**同一个**设置项，所以它们之间不画分隔线。 */}
        <SettingsRow
          label={inputModelLabel}
          divider={false}
          control={
            localDownloading ? (
              <span className={styles.asrModelProgress}>
                {`${t('settings.media.localModelDownloading')} ${localDownloadPercent}%`}
              </span>
            ) : (
              <SelectWidget
                value={inputModelValue}
                onChange={handleInputModelChange}
                disabled={!speechConfigReady || !voiceInputEnabled || inputModelLocked}
                options={inputModelOptions}
              />
            )
          }
        />
        {/* 确认 / 下载中 / 失败：三种状态共用这一行，不新开设置入口 */}
        {asrFlowVisible && (
          <SettingsRow
            label={asrFlowLabel}
            hint={asrFlowHint}
            divider={false}
            layout="inline-hint"
            hintVariant={asrFlowFailed ? 'warn' : 'default'}
            control={
              <div className={styles.asrModelRowActions}>
                {asrFlowFailed ? (
                  <>
                    <button type="button" className={styles.asrModelDownloadButton}
                      onClick={() => void startLocalDownload()}>
                      {t('settings.media.localModelRetry')}
                    </button>
                    <button type="button" className={styles.asrModelDownloadButton}
                      onClick={() => void startLocalDownload(nextSourceId())}>
                      {t('settings.media.localModelSwitchSource')}
                    </button>
                    {/* 失败时这条出口照样要在 —— 用户可能就是"下载不通、但我自己有一份" */}
                    <button type="button" className={styles.asrModelDownloadButton}
                      onClick={() => setAsrImportOpen(true)}>
                      {t('settings.media.localModelManual')}
                    </button>
                  </>
                ) : localDownloading ? (
                  <button type="button" className={styles.asrModelDownloadButton}
                    onClick={() => void cancelLocalDownload()}>
                    {t('settings.media.localModelCancel')}
                  </button>
                ) : (
                  <>
                    {/* 「开始下载」与「我已有模型文件」是**并列**的：
                        有现成文件的人根本不需要下载，不该逼他先下载失败一次才看到这条出口。
                        这里也不再需要"取消"—— 不点"开始下载"就是不下，多一个取消只是噪声。 */}
                    <button type="button" className={styles.asrModelDownloadButton}
                      onClick={() => void startLocalDownload()}>
                      {t('settings.media.localModelStart')}
                    </button>
                    <button type="button" className={styles.asrModelDownloadButton}
                      onClick={() => setAsrImportOpen(true)}>
                      {t('settings.media.localModelManual')}
                    </button>
                  </>
                )}
              </div>
            }
          />
        )}
        {/* 二级面板：拖拽 / 选目录导入。
            显示条件里必须带**"确实还缺东西"** —— 否则模型已经装好了它还挂在那儿，
            看起来就像"装好了也被当成没装"（用户实测到过这个现象）。 */}
        {asrImportOpen && localModelNeedsDownload && (
          <AsrModelImport
            missingGroups={localMissingGroups}
            labelOf={shortModelLabel}
            onImported={() => void loadAsrModels()}
            onClose={() => setAsrImportOpen(false)}
          />
        )}
      </SettingsSection>
    </div>
  );
}
