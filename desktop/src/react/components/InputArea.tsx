/**
 * InputArea — 聊天输入区域 React 组件
 *
 * 子组件拆分到 ./input/ 目录。
 * 斜杠命令逻辑在 ./input/slash-commands.ts。
 */

import { useState, useEffect, useRef, useCallback, useMemo, type ChangeEvent } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor, JSONContent } from '@tiptap/core';
import { useStore } from '../stores';
import { HOME_DRAFT_KEY } from '../../../../shared/input-drafts.ts';
import { selectPreviewItems, selectActiveTabId } from '../stores/preview-slice';
import { sessionScopedListIncludes, sessionScopedValue } from '../stores/session-slice';
import { getSessionCompactionMode, isSessionCompacting } from '../stores/context-slice';
import { selectSessionFiles } from '../stores/selectors/file-refs';
import { isImageFile, isVideoFile } from '../utils/format';
import { isAudioFileName } from '../utils/file-kind';
import { useI18n } from '../hooks/use-i18n';
import {
  continueDeletedAgentSession,
  ensureSession,
  loadSessions,
  upsertOptimisticSessionFirstMessage,
  type SessionRef,
} from '../stores/session-actions';
import { getWebSocket } from '../services/websocket';
import { collectUiContext } from '../utils/ui-context';
import { formatQuotedSelectionForPrompt } from '../utils/quoted-selection';
import { renderMarkdown } from '../utils/markdown';
import { getModelThinkingLevels, type ThinkingLevel } from '../stores/model-slice';
import { SlashCommandMenu } from './input/SlashCommandMenu';
import { MentionMenu, type MentionMenuItem } from './input/MentionMenu';
import { InputStatusBars } from './input/InputStatusBars';
import { InputContextRow } from './input/InputContextRow';
import { InputControlBar } from './input/InputControlBar';
import type { PermissionMode } from './input/PlanModeButton';
import { SessionConfirmationPrompt } from './input/SessionConfirmationPrompt';
import { serializeEditor } from '../utils/editor-serializer';
import { createPcm16Converter } from '../utils/pcm16';
import { startAsrStream, SPEECH_SAMPLE_RATE, type AsrStreamHandlers, type AsrStreamSession } from '../services/asr-stream';
import { createBatchAsrSession, MAX_BATCH_RECORDING_MS } from '../services/asr-batch';
import {
  clearSpeechPreview,
  setSpeechPreview,
  speechPreviewKey,
} from './input/speech-preview-extension';
import {
  buildFileMentionItems,
  mergeEditorFileRefs,
  type FileMentionItem,
} from '../utils/file-mention-items';
import {
  buildAgentMentionItems,
  buildSessionMentionItems,
  type MentionTab,
} from '../utils/mention-items';
import { useServerSlashCommandItems, useSkillSlashItems } from '../hooks/use-slash-items';
import { notifyPasteUploadFailure } from '../utils/paste-upload-feedback';
import { extractPlainUrlPaste } from '../utils/plain-url-paste';
import { createInputEditorExtensions } from './input/input-editor-extensions';
import {
  evaluateChatImageSendPreflight,
  evaluateChatAudioSendPreflight,
  evaluateChatVideoSendPreflight,
  getModelAudioInputMode,
  notifyTextModelImageFileOnly,
  notifyTextModelAudioBlocked,
  notifyTextModelVideoFileOnly,
} from '../utils/chat-image-send-preflight';
import { openProviderModelSettings } from '../utils/model-settings-navigation';
import { shouldShowThinkingControl } from '../utils/model-thinking';
import { shouldAllowInputFocus } from '../utils/input-focus-policy';
import { calculateInputCardBottomInset, parseCssPixels } from '../utils/input-card-layout';
import { buildWaveformFromBlob, buildWaveformFromPcmChunks } from '../utils/audio-waveform';
import { prepareChatImageUpload } from '../utils/chat-image-upload-compression';
import {
  XING_PROMPT, executeDiary, executeCompact, executeSlashViaWs, buildSlashCommands, getSlashMatches,
  resolveSlashSubmitSelection, applySlashCompletion,
  type SlashItem,
} from './input/slash-commands';
import { attachFilesFromPaths } from '../MainContent';
import { searchDeskFiles } from '../stores/desk-actions';
import { hanaFetch } from '../hooks/use-hana-fetch';
import type { DeskSearchResult } from '../types';
import styles from './input/InputArea.module.css';
import type { AudioWaveform, ChatListItem, SessionConfirmationBlock, SessionModel } from '../stores/chat-types';

const EMPTY_FILE_REFS: readonly import('../types/file-ref').FileRef[] = Object.freeze([]);

function modelUnavailableMessageKey(reason: SessionModel['unavailableReason']): string {
  if (reason === 'model_removed') return 'model.unavailableReason.modelRemoved';
  if (reason === 'provider_not_configured') return 'model.unavailableReason.providerNotConfigured';
  return 'model.unavailableReason.temporarilyUnavailable';
}

function chatVideoMimeTypeForName(name: string, fallback?: string): string {
  if (fallback?.startsWith('video/')) return fallback;
  const ext = name.toLowerCase().replace(/^.*\./, '');
  const mimeMap: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
  };
  return mimeMap[ext] || 'video/mp4';
}

function chatImageMimeTypeForName(name: string, fallback?: string): string {
  if (fallback?.startsWith('image/')) return fallback;
  const ext = name.toLowerCase().replace(/^.*\./, '');
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
  };
  return mimeMap[ext] || 'image/png';
}

function chatAudioMimeTypeForName(name: string, fallback?: string): string {
  if (fallback?.startsWith('audio/')) return fallback;
  const ext = name.toLowerCase().replace(/^.*\./, '');
  const mimeMap: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    weba: 'audio/webm',
    webm: 'audio/webm',
  };
  return mimeMap[ext] || 'audio/wav';
}

function createClientUserMessageId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `client-user-${uuid}`;
  return `client-user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createStopRequest(input: {
  sessionId: string | null | undefined;
  sessionPath: string | null | undefined;
  streamId: string | null | undefined;
}): { type: 'abort'; sessionId: string; sessionPath: string; streamId?: string } | null {
  const sessionId = input.sessionId?.trim();
  const sessionPath = input.sessionPath?.trim();
  const streamId = input.streamId?.trim();
  if (!sessionId || !sessionPath) return null;
  return {
    type: 'abort',
    sessionId,
    sessionPath,
    ...(streamId ? { streamId } : {}),
  };
}

async function readFileAsBase64(file: File): Promise<string> {
  return readBlobAsBase64(file);
}

async function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('file read failed'));
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const comma = value.indexOf(',');
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.readAsDataURL(blob);
  });
}

function mergeFloat32Chunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function encodeWavBlob(chunks: Float32Array[], sampleRate: number): Blob {
  const samples = mergeFloat32Chunks(chunks);
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }
  return new Blob([view], { type: 'audio/wav' });
}

function formatRecordingElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

interface AudioRecorderRuntime {
  stream: MediaStream;
  audioContext: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  silentGain: GainNode;
  chunks: Float32Array[];
  sampleRate: number;
}

function disposeAudioRecorderRuntime(runtime: AudioRecorderRuntime): void {
  try { runtime.processor.disconnect(); } catch {}
  try { runtime.source.disconnect(); } catch {}
  try { runtime.silentGain.disconnect(); } catch {}
  for (const track of runtime.stream.getTracks()) {
    try { track.stop(); } catch {}
  }
  if (runtime.audioContext.state !== 'closed') {
    void runtime.audioContext.close().catch(() => {});
  }
}

interface FileMentionRange {
  from: number;
  to: number;
  query: string;
}

interface SlashTriggerRange {
  from: number;
  to: number;
}

interface InputKeyEvent {
  key: string;
  shiftKey: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  preventDefault: () => void;
}

function findLatestInputSessionConfirmation(items: ChatListItem[] | undefined, confirmId?: string, pendingOnly?: boolean): SessionConfirmationBlock | null {
  if (!items) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type !== 'message' || item.data.role !== 'assistant') continue;
    const blocks = item.data.blocks || [];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j];
      if (block.type !== 'session_confirmation' || block.surface !== 'input') continue;
      if (confirmId && block.confirmId !== confirmId) continue;
      if (pendingOnly && block.status !== 'pending') continue;
      return block;
    }
  }
  return null;
}

function findFileMentionRange(editor: Editor | null): FileMentionRange | null {
  if (!editor?.state?.selection) return null;
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const before = selection.$from.parent.textBetween(0, selection.$from.parentOffset, '\n', '\n');
  const atIndex = before.lastIndexOf('@');
  if (atIndex < 0) return null;
  if (atIndex > 0 && /\S/.test(before[atIndex - 1])) return null;
  const query = before.slice(atIndex + 1);
  if (/[\s@]/.test(query)) return null;
  return {
    from: selection.from - query.length - 1,
    to: selection.from,
    query,
  };
}

function findSlashTriggerRange(editor: Editor | null): SlashTriggerRange | null {
  if (!editor?.state?.selection) return null;
  const { selection } = editor.state;
  if (!selection.empty) return null;

  const parent = selection.$from.parent;
  const cursorOffset = selection.$from.parentOffset;
  const parentStart = selection.$from.start();
  const units: Array<{ char: string | null; from: number }> = [];

  parent.forEach((node, offset) => {
    if (offset >= cursorOffset) return;
    const sizeBeforeCursor = Math.min(node.nodeSize, cursorOffset - offset);
    if (sizeBeforeCursor <= 0) return;

    if (!node.isText || typeof node.text !== 'string') {
      units.push({
        char: null,
        from: parentStart + offset,
      });
      return;
    }

    const textLength = Math.min(node.text.length, sizeBeforeCursor);
    for (let index = 0; index < textLength; index += 1) {
      const from = parentStart + offset + index;
      units.push({ char: node.text[index], from });
    }
  });

  let index = units.length - 1;
  while (index >= 0) {
    const char = units[index].char;
    if (char === null || char === '/' || /\s/u.test(char)) break;
    index -= 1;
  }

  const slash = units[index];
  if (!slash || slash.char !== '/') return null;
  const beforeSlash = units[index - 1];
  if (beforeSlash && beforeSlash.char !== null && !/\s/u.test(beforeSlash.char)) return null;

  return { from: slash.from, to: selection.from };
}

function editorHasInlineNode(editor: Editor | null, nodeType: string): boolean {
  if (!editor?.state?.doc) return false;
  let found = false;
  editor.state.doc.descendants((node) => {
    if (node.type.name === nodeType) {
      found = true;
      return false;
    }
    return !found;
  });
  return found;
}

/**
 * 发送按钮的可用态（hasContent）与 submitEditorMessage 的空消息拦截曾经各写一份判据，
 * 后者不含 skills，导致纯 skillBadge 消息在按钮上可点、提交时却被当空消息静默吞掉（#2101）。
 * 两处必须共用这一份谓词，任何新增的"内容维度"只需要改这一处。
 */
function composerPayloadIsEmpty(payload: {
  hasText: boolean;
  hasFiles: boolean;
  hasSkills: boolean;
  hasMentions: boolean;
  hasDocContext: boolean;
  hasQuotes: boolean;
}): boolean {
  return !payload.hasText && !payload.hasFiles && !payload.hasSkills && !payload.hasMentions
    && !payload.hasDocContext && !payload.hasQuotes;
}

function plainTextToEditorDocument(text: string): JSONContent {
  return {
    type: 'doc',
    content: text.split('\n').map(line => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}

/**
 * inputText 是 TipTap 的 React 镜像，不是正文权威。
 *
 * 历史：TipTap 落地时 `inputText = editor.getText()` 直接派生（认 TipTap），
 * 但 editor 变更不触发 React re-render，发送按钮会卡死（bd4844297），
 * 于是改成 useState + update 事件同步。之后草稿恢复用 emitUpdate:false
 * 绕开 update，镜像脱节 → #2101。
 *
 * 契约：正文权威永远是 editor；任何 emitUpdate:false 写入后必须回读同步镜像。
 */
function syncComposerMirrorFromEditor(
  editor: Editor,
  setInputText: (text: string) => void,
): string {
  const { text } = serializeEditor(editor.getJSON());
  setInputText(text);
  return text;
}

/** 程序性写入编辑器并回读同步镜像（禁止只 setContent 不 sync）。 */
function applyComposerDocument(
  editor: Editor,
  nextDoc: JSONContent | null,
  setInputText: (text: string) => void,
): void {
  if (!nextDoc) {
    editor.commands.setContent('', { emitUpdate: false });
  } else {
    editor.commands.setContent(nextDoc, { emitUpdate: false });
  }
  syncComposerMirrorFromEditor(editor, setInputText);
}

export type { SlashItem };

// ── 主组件 ──

export interface InputAreaProps {
  surface?: 'desktop' | 'mobile';
}

export function InputArea({ surface = 'desktop' }: InputAreaProps = {}) {
  return <InputAreaInner surface={surface} />;
}

function InputAreaInner({ surface }: Required<InputAreaProps>) {
  const { t, locale } = useI18n();

  // Zustand state
  const isStreaming = useStore(s => sessionScopedListIncludes(s, s.streamingSessions, s.currentSessionPath));
  const connected = useStore(s => s.connected);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const pendingSessionSwitchPath = useStore(s => s.pendingSessionSwitchPath);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const pendingDraftId = useStore(s => s.pendingDraftId);
  const currentAgentId = useStore(s => s.currentAgentId);
  const agents = useStore(s => s.agents);
  const sessions = useStore(s => s.sessions);
  const selectedAgentId = useStore(s => s.selectedAgentId);
  const currentSessionProjection = useStore(s => s.currentSessionPath
    ? s.sessions.find(session => session.path === s.currentSessionPath)
    : null);
  const deletedAgentReadOnly = currentSessionProjection?.agentDeleted === true;
  const compacting = useStore(s => isSessionCompacting(s, currentSessionPath));
  const compactionMode = useStore(s => getSessionCompactionMode(s, currentSessionPath));
  const screenshotBusy = useStore(s => s.screenshotTaskCount > 0);
  const screenshotProgress = useStore(s => s.screenshotProgress);
  const inlineError = useStore(s => s.currentSessionPath ? (sessionScopedValue(s, s.inlineErrors, s.currentSessionPath) ?? null) : null);
  const sessionFiles = useStore(s => (s.currentSessionPath ? selectSessionFiles(s, s.currentSessionPath) : EMPTY_FILE_REFS));
  const attachedFiles = useStore(s => s.attachedFiles);
  const docContextAttached = useStore(s => s.docContextAttached);
  const quotedSelections = useStore(s => s.quotedSelections);
  const deskFiles = useStore(s => s.deskFiles);
  const deskBasePath = useStore(s => s.deskBasePath);
  const previewItems = useStore(selectPreviewItems);
  const activeTabId = useStore(selectActiveTabId);
  const previewOpen = useStore(s => s.previewOpen);
  const models = useStore(s => s.models);
  const agentYuan = useStore(s => s.agentYuan);
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const thinkingLevel = useStore(s => s.thinkingLevel);
  const setThinkingLevel = useStore(s => s.setThinkingLevel);
  const addToast = useStore(s => s.addToast);
  const removeToast = useStore(s => s.removeToast);

  const globalModelInfo = useMemo(() => models.find(m => m.isCurrent), [models]);
  const sessionModel = useStore(s => s.currentSessionPath ? sessionScopedValue(s, s.sessionModelsByPath, s.currentSessionPath) : undefined);
  const sessionModelInfo = useMemo(() => {
    if (!sessionModel) return undefined;
    const full = models.find(m => m.id === sessionModel.id && m.provider === sessionModel.provider);
    return full ? { ...full, ...sessionModel } : sessionModel;
  }, [models, sessionModel]);
  const modelSelectionRequired = !!(currentSessionPath && sessionModel?.available === false);
  const modelUnavailableMessage = modelSelectionRequired
    ? t(modelUnavailableMessageKey(sessionModel?.unavailableReason))
    : null;
  const capabilityRefreshing = useStore(s => sessionScopedListIncludes(s, s.capabilityRefreshingSessions, s.currentSessionPath));
  const compactingStatus = capabilityRefreshing || compacting;
  const compactingStatusLabel = capabilityRefreshing
    ? t('input.refreshAndCompactBusy')
    : t(compactionMode === 'lossy_local' ? 'chat.instantSimpleCompaction' : 'chat.compacting');
  const currentModelInfo = sessionModelInfo || globalModelInfo;
  const availableThinkingLevels = useMemo(
    () => getModelThinkingLevels(currentModelInfo),
    [currentModelInfo],
  );
  // input 数组缺失视为未知；只有显式 text-only 的模型才在 UI 上标记“辅助视觉”。
  const supportsVision = !Array.isArray(currentModelInfo?.input) || currentModelInfo.input.includes("image");
  const showAudioInput = getModelAudioInputMode(currentModelInfo) === 'native-audio';
  // 语音输入（流式转文字）的门控与上面那条完全独立：只看"语音识别是否启用"，
  // 与当前对话模型是否支持原生音频无关。设置弹窗关闭时重新读取，保证改完即生效。
  const settingsModalOpen = useStore(s => !!s.settingsModal?.open);
  const showThinkingControl = useMemo(
    () => shouldShowThinkingControl(currentModelInfo, models),
    [currentModelInfo, models],
  );
  const modelSwitching = useStore(s => s.modelSwitching);
  const currentSessionItems = useStore(s => s.currentSessionPath ? sessionScopedValue(s, s.chatSessions, s.currentSessionPath)?.items : undefined);
  const storedSessionConfirmation = useStore(s => s.currentSessionPath
    ? sessionScopedValue(s, s.pendingSessionConfirmationsByPath, s.currentSessionPath) || null
    : null);
  const pendingSessionConfirmation = useMemo(() => {
    return findLatestInputSessionConfirmation(currentSessionItems, undefined, true)
      || storedSessionConfirmation;
  }, [currentSessionItems, storedSessionConfirmation]);

  // Local state
  const permissionMode = useStore(s => s.sessionPermissionMode);
  const setPermissionMode = useStore(s => s.setSessionPermissionMode);
  const [sending, setSending] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelected, setSlashSelected] = useState(0);
  const [slashBusy, setSlashBusy] = useState<string | null>(null);
  const [slashResult, setSlashResult] = useState<{ text: string; type: 'success' | 'error'; deskDir?: string; filePath?: string } | null>(null);
  const [visibleSessionConfirmation, setVisibleSessionConfirmation] = useState<SessionConfirmationBlock | null>(null);
  const [sessionConfirmationExiting, setSessionConfirmationExiting] = useState(false);

  const isComposing = useRef(false);
  const pasteHandlerRef = useRef<(event: ClipboardEvent) => boolean>(() => false);
  const keyDownHandlerRef = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const beforeInputHandlerRef = useRef<(event: InputEvent) => boolean>(() => false);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const slashBtnRef = useRef<HTMLButtonElement>(null);
  const browserFileInputRef = useRef<HTMLInputElement>(null);
  const slashDismissedTextRef = useRef<string | null>(null);
  const fileMentionSearchSeqRef = useRef(0);
  const inputSurfaceRef = useRef<HTMLDivElement>(null);
  const inputCardRef = useRef<HTMLDivElement>(null);
  const focusFrameRef = useRef<number | null>(null);
  const audioRecorderRef = useRef<AudioRecorderRuntime | null>(null);
  const audioRecordingSeqRef = useRef(0);
  const [inputText, setInputText] = useState('');
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [mentionTab, setMentionTab] = useState<MentionTab>('files');
  const [fileSelected, setFileSelected] = useState(0);
  const [fileMentionRange, setFileMentionRange] = useState<FileMentionRange | null>(null);
  const [fileMentionQuery, setFileMentionQuery] = useState('');
  const [fileMentionSearchResults, setFileMentionSearchResults] = useState<DeskSearchResult[]>([]);
  const [fileMentionBusy, setFileMentionBusy] = useState(false);
  const [continuingDeletedAgentSession, setContinuingDeletedAgentSession] = useState(false);
  const [deletedAgentContinueError, setDeletedAgentContinueError] = useState<string | null>(null);
  const [audioRecorderOpen, setAudioRecorderOpen] = useState(false);
  const [audioRecordingState, setAudioRecordingState] = useState<'idle' | 'starting' | 'recording' | 'stopping'>('idle');
  const [audioRecordingStartedAt, setAudioRecordingStartedAt] = useState<number | null>(null);
  const [audioRecordingElapsed, setAudioRecordingElapsed] = useState(0);
  const [audioRecordingError, setAudioRecordingError] = useState<string | null>(null);
  // ── 语音输入（流式转文字）的状态，与上面的录音按钮互不共用 ──
  /** 语音识别是否已启用（由设置决定）——决定新按钮是否出现 */
  const [speechInputEnabled, setSpeechInputEnabled] = useState(false);
  /** 语音输入引擎（local/cloud/cloud-batch）与本地模型（zh-14M/bilingual），由设置决定 */
  const [speechInputEngine, setSpeechInputEngine] = useState('local');
  const [speechInputLocalModel, setSpeechInputLocalModel] = useState('zh-14M');
  /** 云端批式**专属**的转写模型（与作者的「语音条转录模型」分开，互不影响） */
  const [speechInputBatchModel, setSpeechInputBatchModel] = useState<{ provider: string; id: string } | null>(null);
  /** 云端流式选中的实时模型（候选来自供应商配置，同样与另外两种方式分开存） */
  const [speechInputCloudModel, setSpeechInputCloudModel] = useState<{ provider: string; id: string } | null>(null);
  // connecting：引擎还在起（首次要拉起 sidecar、加载模型，可能几秒）——这期间**没有在录音**，
  // 界面不能说「聆听中」，否则用户开头说的那句会以为被记下了。
  // transcribing：用户已按停止、采集也停了，但引擎还在把剩余音频解完（批式还要上传 + 转写，
  // 可能十几秒）——这时界面应显示「正在转写…」而不是继续「聆听中」。final/超时/出错后回 idle。
  const [speechInputState, setSpeechInputState] = useState<'idle' | 'connecting' | 'listening' | 'transcribing'>('idle');
  /** 同步门闩：state 更新是异步的，靠它挡住连点导致的重复启动 */
  const speechActiveRef = useRef(false);
  /**
   * 递增的「任务编号」。startSpeechInput 里每一步 await 之后都要核对它。
   *
   * 为什么不能只用 speechActiveRef 这个布尔值：它会**被新一轮启动重新置真** ——
   * 用户在启动过程中点了停止、又马上重新开始，上一轮那个还卡在 await 里的调用醒来时
   * 会看到「仍然是 active」，于是继续开麦克风、覆盖新会话的引用，把连接和麦克风都泄漏掉。
   * 编号是单调的，所以「我这一轮还作不作数」能被准确判断。
   */
  const speechTaskIdRef = useRef(0);
  /** 预览与最终插入的锚点（开始说话时的光标位置）；null 表示没有进行中的语音输入 */
  const speechAnchorRef = useRef<number | null>(null);
  /** 识别流会话（到本机 sidecar 的 WebSocket） */
  const speechSessionRef = useRef<AsrStreamSession | null>(null);
  /** 麦克风采集图，收尾时要逐个拆掉 */
  const speechAudioRef = useRef<{
    stream: MediaStream;
    audioContext: AudioContext;
    source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode;
    silentGain: GainNode;
  } | null>(null);
  /** 开始说话时的草稿 key：切会话提交时要把文字写到"上一个会话"的草稿里 */
  const speechDraftKeyRef = useRef<string | null>(null);
  /**
   * 语音提交期间临时屏蔽"编辑器更新 → 保存草稿"。
   * 切会话提交时文档还属于上一个会话，若不屏蔽，更新回调会把旧内容写进新会话的草稿。
   */
  const speechSuppressDraftSyncRef = useRef(false);
  /** 用户按停止后等 final 的兜底计时器，防止引擎不回声时界面卡在"聆听中" */
  const speechFinalTimerRef = useRef<number | null>(null);
  /**
   * 批式录音的自动停止计时器（到 MAX_BATCH_RECORDING_MS 触发一次，见下）。
   * 只有云端批式才需要 —— 它把整段 PCM 攒着一次性上传，必须有真实的上限。
   */
  const speechMaxDurationTimerRef = useRef<number | null>(null);
  /**
   * 收尾是否已经发起过。用户连点"停止"时，第一次发起 finish（进入转写），
   * 之后再点就变成"立刻取消/收尾"——不能重复调 session.finish()（批式会重复上传转写）。
   */
  const speechFinishRequestedRef = useRef(false);
  /**
   * 指向 handleSpeechInputToggle 的 ref。批式自动停止计时器在 startSpeechInput 里设置，
   * 而那个函数定义在 toggle 之前，直接引用会造成 useCallback 循环依赖，所以走 ref。
   */
  const speechStopRef = useRef<() => void>(() => {});
  const inputLocked = deletedAgentReadOnly || continuingDeletedAgentSession;

  useEffect(() => {
    setContinuingDeletedAgentSession(false);
    setDeletedAgentContinueError(null);
  }, [currentSessionPath]);

  useEffect(() => {
    if (pendingSessionConfirmation) {
      setVisibleSessionConfirmation(pendingSessionConfirmation);
      setSessionConfirmationExiting(false);
      return;
    }
    if (!visibleSessionConfirmation || sessionConfirmationExiting) return;

    const resolved = findLatestInputSessionConfirmation(currentSessionItems, visibleSessionConfirmation.confirmId);
    setVisibleSessionConfirmation(resolved || visibleSessionConfirmation);
    setSessionConfirmationExiting(true);
  }, [currentSessionItems, pendingSessionConfirmation, sessionConfirmationExiting, visibleSessionConfirmation]);

  useEffect(() => {
    if (!sessionConfirmationExiting) return;
    const timer = window.setTimeout(() => {
      setVisibleSessionConfirmation(null);
      setSessionConfirmationExiting(false);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [sessionConfirmationExiting]);

  // ── 全局 inline notice（截图等非斜杠命令的轻提示）──
  useEffect(() => {
    const handler = (e: Event) => {
      const { text, type, deskDir, filePath } = (e as CustomEvent).detail;
      setSlashResult({ text, type, deskDir, filePath });
      setTimeout(() => setSlashResult(null), 3000);
    };
    window.addEventListener('hana-inline-notice', handler);
    return () => window.removeEventListener('hana-inline-notice', handler);
  }, []);

  // ── Welcome 模式 placeholder tip（mount、i18n ready、每次 welcome 重新激活时随机一条） ──
  const pickRandomWelcomeTip = useCallback((): string => {
    const tipsRaw: unknown = t('welcome.placeholderTips');
    const tips = Array.isArray(tipsRaw)
      ? tipsRaw.filter((tip): tip is string => typeof tip === 'string' && tip.length > 0)
      : [];
    if (tips.length === 0) return '';
    return tips[Math.floor(Math.random() * tips.length)];
  }, [t]);

  const [welcomeTip, setWelcomeTip] = useState<string>(() =>
    welcomeVisible ? pickRandomWelcomeTip() : '',
  );

  // Zustand actions
  const addAttachedFile = useStore(s => s.addAttachedFile);
  const removeAttachedFile = useStore(s => s.removeAttachedFile);
  const clearAttachedFiles = useStore(s => s.clearAttachedFiles);
  const clearAttachedFilesForSession = useStore(s => s.clearAttachedFilesForSession);
  const setDocContextAttached = useStore(s => s.setDocContextAttached);
  const setDraft = useStore(s => s.setDraft);
  const clearDraft = useStore(s => s.clearDraft);
  // 草稿 key：session 内用 sessionPath（store 内解析为 sessionId）；首页 pending 态用保留键
  const draftKey = currentSessionPath ?? (pendingNewSession ? HOME_DRAFT_KEY : null);

  const prevWelcomeVisibleRef = useRef(welcomeVisible);
  const prevLocaleRef = useRef(locale);
  useEffect(() => {
    const wasVisible = prevWelcomeVisibleRef.current;
    const previousLocale = prevLocaleRef.current;
    prevWelcomeVisibleRef.current = welcomeVisible;
    prevLocaleRef.current = locale;

    if (!welcomeVisible) {
      if (welcomeTip) setWelcomeTip('');
      return;
    }

    // false→true（重新进入欢迎页）、locale ready/切换，或 mount 时 i18n 还没 ready 现在能拿到
    if (!wasVisible || previousLocale !== locale || !welcomeTip) {
      const tip = pickRandomWelcomeTip();
      if (tip) setWelcomeTip(tip);
    }
  }, [welcomeVisible, locale, welcomeTip, pickRandomWelcomeTip]);

  // ── Placeholder ──
  const placeholderRef = useRef('');
  const getEditorPlaceholder = useCallback(() => placeholderRef.current, []);
  const placeholder = (() => {
    if (welcomeVisible && welcomeTip) return welcomeTip;
    const yuanPh = t(`yuan.placeholder.${agentYuan}`);
    return (yuanPh && !yuanPh.startsWith('yuan.')) ? yuanPh : t('input.placeholder');
  })();
  placeholderRef.current = placeholder;

  // ── TipTap editor ──
  const editor = useEditor({
    // Mobile PWA cold starts can race editor DOM creation with the first render.
    // Create the editor after mount there; keep desktop's immediate path unchanged.
    immediatelyRender: surface !== 'mobile',
    extensions: createInputEditorExtensions(getEditorPlaceholder),
    editorProps: {
      attributes: {
        class: styles['input-box'],
        id: 'inputBox',
        spellcheck: 'false',
      },
      handlePaste: (_view, event) => pasteHandlerRef.current(event),
      handleKeyDown: (_view, event) => keyDownHandlerRef.current(event),
      handleDOMEvents: {
        beforeinput: (_view, event) => beforeInputHandlerRef.current(event as InputEvent),
      },
    },
  });

  useEffect(() => {
    editor?.setEditable?.(!inputLocked);
    if (inputLocked) {
      setSlashMenuOpen(false);
      setFileMenuOpen(false);
    }
  }, [editor, inputLocked]);

  const restoreEditorFocus = useCallback(() => {
    if (!editor || editor.isDestroyed) return;
    if (inputLocked) return;
    if (!shouldAllowInputFocus({ inputRoot: inputSurfaceRef.current })) return;

    const run = () => {
      focusFrameRef.current = null;
      if (!editor || editor.isDestroyed) return;
      if (!shouldAllowInputFocus({ inputRoot: inputSurfaceRef.current })) return;
      editor.commands.focus();
    };

    if (typeof window.requestAnimationFrame === 'function') {
      if (focusFrameRef.current !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(focusFrameRef.current);
      }
      focusFrameRef.current = window.requestAnimationFrame(run);
      return;
    }

    window.setTimeout(run, 0);
  }, [editor, inputLocked]);

  useEffect(() => {
    return () => {
      if (focusFrameRef.current !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(focusFrameRef.current);
      }
      focusFrameRef.current = null;
    };
  }, []);

  useEffect(() => {
    const surface = inputSurfaceRef.current;
    const card = inputCardRef.current;
    const editorElement = editor?.view.dom;
    const parent = card?.closest('.main-content') as HTMLElement | null;
    if (!surface || !card || !editorElement || !parent) return;

    const updateMetrics = () => {
      const editorStyle = window.getComputedStyle(editorElement);
      const editorFontSize = parseCssPixels(editorStyle.fontSize, 16);
      const editorLineHeight = parseCssPixels(editorStyle.lineHeight, editorFontSize * 1.6);
      const cardRect = card.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      const cardHeight = cardRect.height || card.offsetHeight;
      const editorHeight = editorElement.getBoundingClientRect().height || editorElement.offsetHeight;
      const upperChromeHeight = Math.max(0, cardRect.top - surfaceRect.top);
      const bottomInset = calculateInputCardBottomInset({
        cardHeight,
        editorHeight,
        editorLineHeight,
        upperChromeHeight,
      });

      parent.style.setProperty('--input-card-h', `${cardHeight}px`);
      parent.style.setProperty('--input-card-bottom-inset', `${bottomInset}px`);
    };

    updateMetrics();

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        parent.style.removeProperty('--input-card-h');
        parent.style.removeProperty('--input-card-bottom-inset');
      };
    }

    const observer = new ResizeObserver(updateMetrics);
    observer.observe(surface);
    observer.observe(card);
    observer.observe(editorElement);

    return () => {
      observer.disconnect();
      parent.style.removeProperty('--input-card-h');
      parent.style.removeProperty('--input-card-bottom-inset');
    };
  }, [editor]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta('input-placeholder-refresh', placeholder));
  }, [editor, placeholder]);

  // Focus trigger from store
  const inputFocusTrigger = useStore(s => s.inputFocusTrigger);
  const inputFocusTriggerSource = useStore(s => s.inputFocusTriggerSource);
  useEffect(() => {
    if (inputFocusTrigger <= 0) return;
    // 'restore' (turn-end give-the-focus-back-to-the-editor convenience) is desktop-only: on
    // mobile/PWA it pops the on-screen keyboard every time a reply finishes (#2045 symptom 3).
    // 'gesture' (explicit user action, e.g. quoting a selection) is never blocked.
    if (inputFocusTriggerSource === 'restore' && surface !== 'desktop') return;
    restoreEditorFocus();
  }, [inputFocusTrigger, inputFocusTriggerSource, restoreEditorFocus, surface]);

  useEffect(() => {
    if (surface !== 'desktop') return;
    const handleWindowFocus = () => restoreEditorFocus();
    window.addEventListener('focus', handleWindowFocus);
    return () => window.removeEventListener('focus', handleWindowFocus);
  }, [restoreEditorFocus, surface]);

  // Doc context
  const currentDoc = useMemo(() => {
    if (!previewOpen || !activeTabId) return null;
    const art = previewItems.find(a => a.id === activeTabId);
    if (!art?.filePath) return null;
    return { path: art.filePath, name: art.title || art.filePath.split('/').pop() || '' };
  }, [previewOpen, activeTabId, previewItems]);
  const hasDoc = !!currentDoc;

  // doc 消失时同步清 attach，避免悬空的 docContextAttached 干扰 hasContent / 发送态
  useEffect(() => {
    if (!hasDoc && docContextAttached) setDocContextAttached(false);
  }, [hasDoc, docContextAttached, setDocContextAttached]);

  // ── 统一命令发送 ──

  const sendAsUser = useCallback(async (text: string, displayText?: string): Promise<boolean> => {
    if (inputLocked) return false;
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const _s = useStore.getState();
    if (sessionScopedListIncludes(_s, _s.streamingSessions, _s.currentSessionPath)) return false;
    if (_s.pendingSessionSwitchPath) return false;
    const activeSessionModel = _s.currentSessionPath
      ? sessionScopedValue(_s, _s.sessionModelsByPath, _s.currentSessionPath)
      : undefined;
    if (activeSessionModel?.available === false) {
      _s.addToast(
        t(modelUnavailableMessageKey(activeSessionModel.unavailableReason)),
        'warning',
        6000,
        { dedupeKey: 'session-model-unavailable' },
      );
      return false;
    }

    let sessionRef: Readonly<SessionRef> | null = null;
    if (pendingNewSession) {
      sessionRef = await ensureSession(pendingDraftId);
      if (!sessionRef) return false;
      loadSessions();
    } else {
      const state = useStore.getState();
      const projection = state.sessions.find(session => session.path === state.currentSessionPath);
      const sessionId = state.currentSessionId || projection?.sessionId || null;
      const agentId = projection?.agentId || state.currentAgentId || null;
      if (!state.currentSessionPath || !sessionId || !agentId) return false;
      sessionRef = Object.freeze({ sessionId, sessionPath: state.currentSessionPath, agentId });
    }

    ws.send(JSON.stringify({
      type: 'prompt',
      text,
      sessionId: sessionRef.sessionId,
      sessionPath: sessionRef.sessionPath,
      uiContext: collectUiContext(_s),
      displayMessage: { text: displayText ?? text },
    }));
    return true;
  }, [inputLocked, pendingDraftId, pendingNewSession, t]);

  // ── 斜杠命令 ──

  const diaryFn = useCallback(() => {
    executeDiary(t, addToast, removeToast, () => { editor?.commands.clearContent(); }, setSlashMenuOpen)();
  }, [t, addToast, removeToast, editor]);
  const xingFn = useCallback(async () => {
    editor?.commands.clearContent();
    setSlashMenuOpen(false);
    await sendAsUser(XING_PROMPT);
  }, [sendAsUser, editor]);
  const compactFn = useCallback(async () => {
    await executeCompact(t, setSlashBusy, () => { editor?.commands.clearContent(); }, setSlashMenuOpen)();
  }, [editor, t]);

  // 这个输入框归属哪个助手：已有会话以会话自己的记录为准，新会话草稿才用选中的助手。
  // 菜单里列出谁的命令、@ 菜单把谁认作"当前助手"、以及 slash 请求发给服务端的执行身份，
  // 三处都读这一个值——它们说的是同一件事，分头算迟早会算出不一样的答案。
  const slashAgentId = pendingNewSession
    ? (selectedAgentId || currentAgentId)
    : (currentSessionProjection?.agentId || currentAgentId);
  const skillItems = useSkillSlashItems({ enabled: surface !== 'mobile', agentId: slashAgentId });
  const serverCommandItems = useServerSlashCommandItems({ enabled: surface !== 'mobile', agentId: slashAgentId });

  // 注：/stop /new /reset 仅走 bridge 平台（TG/Feishu/...）；桌面端有 GUI，菜单不暴露这些命令。
  // serverCommandItems 只展示非 core 的服务端命令（插件 / 扩展），避免把桌面已有 GUI 的 core 命令重复暴露。
  const slashCommands = useMemo(
    () => [...buildSlashCommands(t, diaryFn, xingFn, compactFn), ...serverCommandItems, ...skillItems],
    [diaryFn, xingFn, compactFn, t, serverCommandItems, skillItems],
  );

  const filteredCommands = useMemo(() => {
    if (!inputText.startsWith('/')) return slashCommands;
    return getSlashMatches(inputText, slashCommands);
  }, [inputText, slashCommands]);

  useEffect(() => {
    setSlashSelected(index => Math.min(index, Math.max(filteredCommands.length - 1, 0)));
  }, [filteredCommands.length]);

  const fileMentionItems = useMemo(() => buildFileMentionItems({
    query: fileMentionQuery,
    attachedFiles,
    sessionFiles,
    deskFiles,
    deskBasePath,
    deskCurrentPath: '',
    searchResults: fileMentionSearchResults,
    includeWorkspace: true,
    limit: 20,
  }), [
    attachedFiles,
    deskBasePath,
    deskFiles,
    fileMentionQuery,
    fileMentionSearchResults,
    sessionFiles,
  ]);

  useEffect(() => {
    if (!fileMenuOpen) {
      setFileMentionSearchResults([]);
      setFileMentionBusy(false);
      return;
    }

    const query = fileMentionQuery.trim();
    const seq = ++fileMentionSearchSeqRef.current;
    if (!query) {
      setFileMentionSearchResults([]);
      setFileMentionBusy(false);
      return;
    }

    setFileMentionBusy(true);
    const timer = window.setTimeout(() => {
      searchDeskFiles(query)
        .then((results) => {
          if (fileMentionSearchSeqRef.current === seq) setFileMentionSearchResults(results);
        })
        .catch((err: unknown) => {
          if (fileMentionSearchSeqRef.current === seq) setFileMentionSearchResults([]);
          console.warn('[file-mention] search failed', err);
        })
        .finally(() => {
          if (fileMentionSearchSeqRef.current === seq) setFileMentionBusy(false);
        });
    }, 120);

    return () => window.clearTimeout(timer);
  }, [fileMentionQuery, fileMenuOpen]);

  const sessionMentionItems = useMemo(() => buildSessionMentionItems({
    sessions,
    query: fileMentionQuery,
  }), [fileMentionQuery, sessions]);

  const agentMentionItems = useMemo(() => buildAgentMentionItems({
    agents,
    query: fileMentionQuery,
    currentAgentId: slashAgentId,
  }), [agents, fileMentionQuery, slashAgentId]);

  const mentionItems = useMemo<MentionMenuItem[]>(() => {
    if (mentionTab === 'sessions') return sessionMentionItems;
    if (mentionTab === 'agents') return agentMentionItems;
    return fileMentionItems;
  }, [agentMentionItems, fileMentionItems, mentionTab, sessionMentionItems]);

  const dismissSlashMenu = useCallback(() => {
    const text = editor?.getText().trim() ?? inputText.trim();
    slashDismissedTextRef.current = text.startsWith('/') ? text : null;
    setSlashMenuOpen(false);
  }, [editor, inputText]);

  const openSlashMenu = useCallback(() => {
    slashDismissedTextRef.current = null;
    setSlashMenuOpen(true);
  }, []);

  useEffect(() => {
    if (fileSelected < mentionItems.length) return;
    setFileSelected(Math.max(0, mentionItems.length - 1));
  }, [mentionItems.length, fileSelected]);

  const handleSlashToggle = useCallback(() => {
    if (slashMenuOpen) dismissSlashMenu();
    else openSlashMenu();
  }, [slashMenuOpen, dismissSlashMenu, openSlashMenu]);

  const handleBrowserFileInputChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    if (inputLocked) {
      event.currentTarget.value = '';
      return;
    }
    const files = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = '';
    try {
      if (files.length === 0) return;
      if (useStore.getState().attachedFiles.length >= 9) return;

      for (const file of files) {
        if (useStore.getState().attachedFiles.length >= 9) break;
        const mimeType = file.type || (isAudioFileName(file.name) ? chatAudioMimeTypeForName(file.name) : chatImageMimeTypeForName(file.name));
        try {
          const base64Data = await readFileAsBase64(file);
          const uploadPayload = mimeType.startsWith('image/')
            ? await prepareChatImageUpload({
              file,
              name: file.name,
              base64Data,
              mimeType,
            })
            : {
              name: file.name,
              base64Data,
              mimeType,
              compressed: false,
            };
          const waveform = mimeType.startsWith('audio/')
            ? await buildWaveformFromBlob(file).catch((err) => {
              console.warn('[upload] failed to compute audio waveform', err);
              return undefined;
            })
            : undefined;
          const res = await hanaFetch('/api/upload-blob', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: uploadPayload.name,
              base64Data: uploadPayload.base64Data,
              mimeType: uploadPayload.mimeType,
              ...(waveform ? { waveform } : {}),
              ...(useStore.getState().currentSessionPath ? { sessionPath: useStore.getState().currentSessionPath } : {}),
            }),
          });
          const data = await res.json();
          const upload = data?.uploads?.[0];
          if (upload?.dest) {
            addAttachedFile({
              fileId: upload.fileId,
              path: upload.dest,
              name: upload.name || uploadPayload.name,
              isDirectory: false,
              base64Data: uploadPayload.base64Data,
              mimeType: uploadPayload.mimeType,
              waveform: upload.waveform || waveform,
            });
          } else {
            useStore.getState().addToast(t('error.uploadFailed'), 'error');
            console.warn('[upload] browser file upload failed', upload?.error || data);
          }
        } catch (err) {
          console.warn('[upload] browser file upload error', err);
          useStore.getState().addToast(t('error.uploadFailed'), 'error');
        }
      }
    } finally {
      restoreEditorFocus();
    }
  }, [addAttachedFile, inputLocked, restoreEditorFocus, t]);

  const handleAttach = useCallback(async () => {
    if (inputLocked) return;
    if (surface === 'mobile') {
      browserFileInputRef.current?.click();
      return;
    }
    if (typeof window.platform?.selectFiles === 'function') {
      try {
        const paths = await window.platform.selectFiles();
        if (paths && paths.length > 0) await attachFilesFromPaths(paths);
      } finally {
        restoreEditorFocus();
      }
      return;
    }
    browserFileInputRef.current?.click();
    window.setTimeout(restoreEditorFocus, 0);
  }, [inputLocked, restoreEditorFocus, surface]);

  const ensureVoiceSessionRef = useCallback(async (): Promise<Readonly<SessionRef>> => {
    const state = useStore.getState();
    const sessionPath = state.currentSessionPath;
    if (sessionPath) {
      const projection = state.sessions.find(session => session.path === sessionPath);
      const sessionId = state.currentSessionId || projection?.sessionId || null;
      const agentId = projection?.agentId || state.currentAgentId || null;
      if (!sessionId || !agentId) throw new Error('missing session identity');
      return Object.freeze({ sessionId, sessionPath, agentId });
    }
    if (!pendingNewSession) throw new Error('missing session path');
    const ref = await ensureSession(pendingDraftId);
    if (!ref) throw new Error('failed to create session');
    loadSessions();
    return ref;
  }, [pendingDraftId, pendingNewSession]);

  const sendVoiceAudioAttachment = useCallback(async (file: {
    fileId?: string;
    path: string;
    name: string;
    mimeType: string;
    base64Data: string;
    waveform?: AudioWaveform;
  }): Promise<boolean> => {
    if (inputLocked || modelSelectionRequired || !connected || isStreaming || sending || modelSwitching || useStore.getState().pendingSessionSwitchPath) {
      return false;
    }

    const audioPreflight = await evaluateChatAudioSendPreflight({
      attachments: [file],
      model: currentModelInfo,
    });
    if (!audioPreflight.ok) {
      notifyTextModelAudioBlocked({
        t,
        addToast: useStore.getState().addToast,
        openSettings: () => openProviderModelSettings(currentModelInfo?.provider),
      });
      return false;
    }

    setSending(true);
    try {
      const sessionRef = await ensureVoiceSessionRef();
      const ws = getWebSocket();
      if (!ws || typeof ws.send !== 'function') {
        throw new Error('websocket unavailable');
      }
      const mimeType = chatAudioMimeTypeForName(file.name, file.mimeType);
      ws.send(JSON.stringify({
        type: 'prompt',
        text: '',
        sessionId: sessionRef.sessionId,
        sessionPath: sessionRef.sessionPath,
        uiContext: collectUiContext(useStore.getState()),
        displayMessage: {
          text: '',
          attachments: [{
            fileId: file.fileId,
            path: file.path,
            name: file.name,
            isDir: false,
            mimeType,
            presentation: 'voice-input',
            listed: false,
            ...(file.waveform ? { waveform: file.waveform } : {}),
          }],
        },
        audios: [{
          type: 'audio',
          data: file.base64Data,
          mimeType,
        }],
      }));
      return true;
    } finally {
      setSending(false);
    }
  }, [
    connected,
    currentModelInfo,
    ensureVoiceSessionRef,
    inputLocked,
    isStreaming,
    modelSwitching,
    modelSelectionRequired,
    sending,
    t,
  ]);

  const stopAudioRecording = useCallback(async ({ discard = false }: { discard?: boolean } = {}) => {
    const runtime = audioRecorderRef.current;
    if (!runtime) {
      setAudioRecordingState('idle');
      setAudioRecordingStartedAt(null);
      setAudioRecordingElapsed(0);
      return;
    }

    audioRecorderRef.current = null;
    setAudioRecordingState(discard ? 'idle' : 'stopping');
    setAudioRecordingStartedAt(null);

    const chunks = runtime.chunks.slice();
    const sampleRate = runtime.sampleRate;
    disposeAudioRecorderRuntime(runtime);

    if (discard) {
      setAudioRecordingElapsed(0);
      return;
    }

    try {
      if (chunks.length === 0) {
        throw new Error('empty audio recording');
      }
      const blob = encodeWavBlob(chunks, sampleRate);
      if (blob.size <= 44) {
        throw new Error('empty audio recording');
      }
      const base64Data = await readBlobAsBase64(blob);
      const waveform = buildWaveformFromPcmChunks(chunks, sampleRate);
      const index = audioRecordingSeqRef.current + 1;
      audioRecordingSeqRef.current = index;
      const name = t('input.recordedAudioName', { index });
      const sessionRef = await ensureVoiceSessionRef();
      const res = await hanaFetch('/api/upload-blob', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          base64Data,
          mimeType: 'audio/wav',
          sessionId: sessionRef.sessionId,
          sessionPath: sessionRef.sessionPath,
          presentation: 'voice-input',
          ...(waveform ? { waveform } : {}),
        }),
      });
      const data = await res.json();
      const upload = data?.uploads?.[0];
      if (!upload?.dest) {
        throw new Error(upload?.error || 'audio upload failed');
      }
      const sent = await sendVoiceAudioAttachment({
        fileId: upload.fileId,
        path: upload.dest,
        name: upload.name || name,
        mimeType: 'audio/wav',
        base64Data,
        waveform: upload.waveform || waveform,
      });
      if (!sent) {
        throw new Error('audio send failed');
      }
      setAudioRecorderOpen(false);
      setAudioRecordingError(null);
    } catch (err) {
      const message = t('input.audioRecordingFailed');
      setAudioRecordingError(message);
      addToast(message, 'error', 6000);
      console.warn('[input] failed to finalize audio recording', err);
    } finally {
      setAudioRecordingState('idle');
      setAudioRecordingElapsed(0);
      restoreEditorFocus();
    }
  }, [addToast, ensureVoiceSessionRef, restoreEditorFocus, sendVoiceAudioAttachment, t]);

  const startAudioRecording = useCallback(async () => {
    if (inputLocked || modelSelectionRequired || !showAudioInput || !connected || isStreaming || sending || modelSwitching || pendingSessionSwitchPath) return;
    if (audioRecordingState !== 'idle' || audioRecorderRef.current) return;
    const AudioContextCtor = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!navigator.mediaDevices?.getUserMedia || !AudioContextCtor) {
      const message = t('input.audioRecordingUnavailable');
      setAudioRecorderOpen(true);
      setAudioRecordingError(message);
      addToast(message, 'error', 6000);
      return;
    }

    setAudioRecorderOpen(true);
    setAudioRecordingError(null);
    setAudioRecordingState('starting');

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const silentGain = audioContext.createGain();
      const chunks: Float32Array[] = [];
      silentGain.gain.value = 0;
      processor.onaudioprocess = (event) => {
        if (!audioRecorderRef.current) return;
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);
      audioRecorderRef.current = {
        stream,
        audioContext,
        source,
        processor,
        silentGain,
        chunks,
        sampleRate: audioContext.sampleRate,
      };
      setAudioRecordingStartedAt(Date.now());
      setAudioRecordingElapsed(0);
      setAudioRecordingState('recording');
    } catch (err) {
      if (stream) {
        for (const track of stream.getTracks()) {
          try { track.stop(); } catch {}
        }
      }
      const message = t('input.audioRecordingFailed');
      setAudioRecordingState('idle');
      setAudioRecordingStartedAt(null);
      setAudioRecordingError(message);
      addToast(message, 'error', 6000);
      console.warn('[input] failed to start audio recording', err);
    }
  }, [
    addToast,
    audioRecordingState,
    connected,
    inputLocked,
    isStreaming,
    modelSwitching,
    modelSelectionRequired,
    pendingSessionSwitchPath,
    sending,
    showAudioInput,
    t,
  ]);

  const handleAudioRecordToggle = useCallback(() => {
    if (audioRecordingState === 'recording') {
      void stopAudioRecording();
      return;
    }
    if (audioRecordingState === 'idle') {
      void startAudioRecording();
    }
  }, [audioRecordingState, startAudioRecording, stopAudioRecording]);

  const canUseVoiceShortcut = useCallback(() => {
    if (surface !== 'desktop') return false;
    if (!showAudioInput) return false;
    if (inputLocked || modelSelectionRequired || modelSwitching) return false;
    if (typeof document !== 'undefined' && !document.hasFocus()) return false;
    const state = useStore.getState() as Record<string, any>;
    if (state.currentTab !== 'chat') return false;
    if (state.pendingSessionSwitchPath) return false;
    if (state.settingsModal?.open || state.mediaViewer || state.skillViewerData || state.channelCreateOverlayVisible) {
      return false;
    }
    return true;
  }, [inputLocked, modelSelectionRequired, modelSwitching, showAudioInput, surface]);

  useEffect(() => {
    if (surface !== 'desktop') return undefined;
    const handleVoiceShortcut = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || !event.shiftKey || event.altKey || key !== 'm') return;
      if (!canUseVoiceShortcut()) return;
      event.preventDefault();
      handleAudioRecordToggle();
    };
    window.addEventListener('keydown', handleVoiceShortcut);
    return () => window.removeEventListener('keydown', handleVoiceShortcut);
  }, [canUseVoiceShortcut, handleAudioRecordToggle, surface]);

  useEffect(() => {
    if (audioRecordingState !== 'recording' || !audioRecordingStartedAt) return undefined;
    const updateElapsed = () => setAudioRecordingElapsed(Date.now() - audioRecordingStartedAt);
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(timer);
  }, [audioRecordingStartedAt, audioRecordingState]);

  useEffect(() => {
    if (showAudioInput || audioRecordingState === 'idle') return undefined;
    void stopAudioRecording({ discard: true });
    setAudioRecorderOpen(false);
    return undefined;
  }, [audioRecordingState, showAudioInput, stopAudioRecording]);

  useEffect(() => {
    return () => {
      const runtime = audioRecorderRef.current;
      if (!runtime) return;
      audioRecorderRef.current = null;
      disposeAudioRecorderRuntime(runtime);
    };
  }, []);

  // Sync editor → React mirror (drives hasInput / canSend) + slash menu + draft save
  useEffect(() => {
    if (!editor) return;
    const handler = () => {
      const editorJson = editor.getJSON();
      const { text } = serializeEditor(editorJson);
      setInputText(text);
      if (slashDismissedTextRef.current && slashDismissedTextRef.current !== text.trim()) {
        slashDismissedTextRef.current = null;
      }
      const slashMatches = getSlashMatches(text, slashCommands);
      const fileMention = findFileMentionRange(editor);
      if (fileMention) {
        setFileMentionRange(fileMention);
        setFileMentionQuery(fileMention.query);
        setFileMenuOpen(true);
        setFileSelected(0);
        setSlashMenuOpen(false);
      } else {
        setFileMenuOpen(false);
        setFileMentionRange(null);
        setFileMentionQuery('');
      }
      if (!fileMention && slashMatches.length > 0 && slashDismissedTextRef.current !== text.trim()) {
        setSlashMenuOpen(true);
        setSlashSelected(0);
      } else {
        setSlashMenuOpen(false);
      }
      // 保存草稿到 store（session 内 + 首页 pending 态）；setDraft 幂等，避免空转
      // 语音"切会话提交"期间跳过：那一刻编辑器里还是上一个会话的文档，而 draftKey
      // 已经指向新会话，照写会污染新会话的草稿（提交方会自己写正确的 key）。
      if (draftKey && !speechSuppressDraftSyncRef.current) {
        setDraft(draftKey, text, editorJson);
      }
      // 内容超出可见区域时，自动滚动到光标位置
      requestAnimationFrame(() => editor.commands.scrollIntoView());
    };
    editor.on('update', handler);
    return () => { editor.off('update', handler); };
  }, [editor, draftKey, setDraft, slashCommands]);

  // ── 语音输入：预览层 + 锚点提交 ────────────────────────────────────
  // 识别引擎会不断吐出新的、而且可能被改写的 partial。这些文字**不写进文档**，
  // 只画成 decoration 预览（见 speech-preview-extension.ts）。只有两种情况才真正
  // 落到文档里：句末（endpoint）和用户按停止（final）。于是撤销历史、草稿保存、
  // 光标位置这三件事都不会被高频 partial 搅乱。

  /** 拆掉麦克风采集图（不碰识别流，收尾时还要等 final） */
  const stopSpeechAudio = useCallback(() => {
    const runtime = speechAudioRef.current;
    speechAudioRef.current = null;
    if (!runtime) return;
    try { runtime.processor.onaudioprocess = null; } catch { /* 已断开 */ }
    try { runtime.source.disconnect(); } catch { /* 已断开 */ }
    try { runtime.processor.disconnect(); } catch { /* 已断开 */ }
    try { runtime.silentGain.disconnect(); } catch { /* 已断开 */ }
    try { runtime.stream.getTracks().forEach(track => track.stop()); } catch { /* 已停止 */ }
    try { void runtime.audioContext.close(); } catch { /* 已关闭 */ }
  }, []);

  const closeSpeechSession = useCallback(() => {
    if (speechFinalTimerRef.current !== null) {
      window.clearTimeout(speechFinalTimerRef.current);
      speechFinalTimerRef.current = null;
    }
    // 会话没了，自动停止计时器也必须撤掉，否则它稍后触发会去动一个已收尾的会话。
    if (speechMaxDurationTimerRef.current !== null) {
      window.clearTimeout(speechMaxDurationTimerRef.current);
      speechMaxDurationTimerRef.current = null;
    }
    const session = speechSessionRef.current;
    speechSessionRef.current = null;
    try { session?.abort(); } catch { /* 已断开 */ }
  }, []);

  /**
   * 把当前预览文字提交进文档。
   * one transaction = one undo step —— 这正是"预览不进文档"换来的好处。
   *
   * @param overrideText 引擎在处理后事件里给的文本（**带标点、中文数字已转阿拉伯数字**）。
   *   必须优先用它 —— 预览层里放的是**原始**识别结果，直接提交预览等于把标点和数字规整
   *   全扔掉。（第一版就是这么错的：句末提交时忽略了事件里的 text，用户看到的永远是原始稿。）
   * @param targetDraftKey 指定要写进哪个草稿；切会话时传上一个会话的 key
   */
  const commitSpeechSegment = useCallback((overrideText?: string, targetDraftKey?: string) => {
    const ed = editor;
    if (!ed || ed.isDestroyed) return;
    // 位置以**插件里那个（随编辑平移过的）锚点**为准 —— 不能用手里的旧数字：
    // 用户听写时可能自己打了字，文档坐标早就变了。
    const anchor = speechPreviewKey.getState(ed.state)?.pos ?? speechAnchorRef.current;
    if (anchor === null) return;
    const preview = speechPreviewKey.getState(ed.state)?.text ?? '';
    const text = (typeof overrideText === 'string' && overrideText) ? overrideText : preview;
    clearSpeechPreview(ed);
    if (!text) return;
    const docSize = ed.state.doc.content.size;
    // 锚点可能因文档被整体替换（切会话、撤销、草稿回填）而失效。
    // 宁可放弃这一句，也不要拿越界位置改文档 —— 那会抛 RangeError。
    if (anchor > docSize) return;

    // 切会话场景：此刻编辑器里还是上一个会话的文档，而 draftKey 已经指向新会话。
    // 屏蔽更新回调里的草稿写入，改成自己显式写到上一个会话的草稿，避免污染新会话。
    const crossSession = typeof targetDraftKey === 'string' && targetDraftKey !== draftKey;
    speechSuppressDraftSyncRef.current = crossSession;
    try {
      // 用 JSON text 节点插入，绕开 TiPTap 对字符串的 HTML 解析
      ed.chain().insertContentAt(anchor, { type: 'text', text }).run();
      // 下一句从插入末尾续写：把插件里的位置也挪过去，这样它会继续跟着后续编辑平移
      speechAnchorRef.current = anchor + text.length;
      setSpeechPreview(ed, { pos: anchor + text.length, text: '' });
      if (crossSession) {
        const json = ed.getJSON();
        setDraft(targetDraftKey!, serializeEditor(json).text, json);
      }
    } catch (err) {
      console.warn('[input] speech commit failed', err);
    } finally {
      speechSuppressDraftSyncRef.current = false;
    }
  }, [draftKey, editor, setDraft]);

  /** 收尾并复位（不提交） */
  const resetSpeechInput = useCallback(() => {
    // 作废「正在启动中」的那一轮：它醒来后会发现编号变了，于是自己收尾
    speechTaskIdRef.current += 1;
    stopSpeechAudio();
    closeSpeechSession();
    if (editor && !editor.isDestroyed) clearSpeechPreview(editor);
    speechAnchorRef.current = null;
    speechDraftKeyRef.current = null;
    speechActiveRef.current = false;
    speechFinishRequestedRef.current = false;
    setSpeechInputState('idle');
  }, [closeSpeechSession, editor, stopSpeechAudio]);

  /** 收尾并提交：句末、用户按停止、切会话、输入被锁定都走这里 */
  const endSpeechInput = useCallback((overrideText?: string, targetDraftKey?: string) => {
    commitSpeechSegment(overrideText, targetDraftKey);
    resetSpeechInput();
    restoreEditorFocus();
  }, [commitSpeechSegment, resetSpeechInput, restoreEditorFocus]);

  /** partial → 只更新预览层，完全不碰文档 */
  const applySpeechPartial = useCallback((partial: string) => {
    const ed = editor;
    if (!ed || ed.isDestroyed || !partial) return;
    // 只更新文字：位置由插件按 transaction 平移，**不要**拿旧锚点覆盖它
    const anchor = speechPreviewKey.getState(ed.state)?.pos ?? speechAnchorRef.current;
    if (anchor === null) return;
    if (anchor > ed.state.doc.content.size) { resetSpeechInput(); return; }
    setSpeechPreview(ed, { text: partial });
  }, [editor, resetSpeechInput]);

  const startSpeechInput = useCallback(async () => {
    const ed = editor;
    if (!ed || ed.isDestroyed) return;
    // 同步门闩：speechInputState 的更新是异步的，只靠它挡不住连点
    if (speechActiveRef.current) return;
    speechActiveRef.current = true;
    // 新一轮开始，收尾标记复位（上一轮的收尾不能被当成这一轮的）
    speechFinishRequestedRef.current = false;
    // 本轮启动的编号；下面每个 await 之后都用它判断「我还算不算数」
    const taskId = speechTaskIdRef.current + 1;
    speechTaskIdRef.current = taskId;
    const isStale = () => speechTaskIdRef.current !== taskId;
    // 关键：记下当前光标位置，预览与最终插入都锚在这里。
    // 同时写进插件状态 —— 之后它会随每一次编辑一起平移，成为那个"唯一的锚点来源"。
    speechAnchorRef.current = ed.state.selection.from;
    setSpeechPreview(ed, { pos: speechAnchorRef.current, text: '' });
    speechDraftKeyRef.current = draftKey ?? null;
    // 这一步只是「正在准备」，还没开始录音 —— 状态如实反映
    setSpeechInputState('connecting');

    const AudioContextCtor = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!navigator.mediaDevices?.getUserMedia || !AudioContextCtor) {
      addToast(t('input.audioRecordingUnavailable'), 'error', 6000);
      resetSpeechInput();
      return;
    }

    try {
      // 1) 先接上识别引擎（本地 sidecar 或云端转发）
      const asrHandlers: AsrStreamHandlers = {
        // partial 是**原始**识别结果 —— 只用于预览，不提交
        onPartial: (text) => applySpeechPartial(text),
        // 句末：用引擎给的**处理后**文本提交（带标点、数字已转阿拉伯数字）
        onEndpoint: (text) => { commitSpeechSegment(text); },
        // 整轮结束：提交剩下没提交过的那一段，然后收尾
        onFinal: (payload) => { endSpeechInput(payload.pending || undefined); },
        onError: (message) => {
          // 批式专用模型没配：给一句能照做的人话，而不是把服务端的英文报错原样弹出来
          const text = message === 'BATCH_MODEL_NOT_CONFIGURED'
            ? t('input.speechBatchModelRequired')
            : (message || t('input.audioRecordingFailed'));
          addToast(text, 'error', 6000);
          // 出错也不能丢已识别的字：预览层是用户已经说出口的内容，裸 reset 会把它
          // 扔掉。endSpeechInput 先把预览剩余文字提交进文档层再收尾（幂等：预览
          // 已空或已收尾时是无害的空操作）。
          endSpeechInput();
        },
      };
      let session: AsrStreamSession;
      // 接引擎单独 try：失败（模型没下载 / sidecar 起不来等）显示真实原因，
      // 别落到外层 catch 被冤枉成"麦克风权限"。
      try {
        if (speechInputEngine === 'cloud-batch') {
          // 云端批式：不接流式连接，录音期间只攒 PCM，松手时一次性上传转写。
          // 复用同一套 session 接口，所以下面的采集、停止、收尾逻辑全都不用改。
          session = createBatchAsrSession({
            sessionPath: draftKey ?? null,
            handlers: asrHandlers,
            batchModel: speechInputBatchModel,
          });
        } else if (speechInputEngine === 'cloud') {
          try {
            session = await startAsrStream(asrHandlers, { engine: 'cloud', cloudModel: speechInputCloudModel });
          } catch {
            // 这里的回退**只覆盖 HTTP 预检失败**：startAsrStream 里那个 POST /api/asr/stream
            // 抛错（服务端不可用等）才会走到这。它连上之后是同步返回的，真正的 WS 握手失败
            // （比如没配 API Key：服务端会先回一条 error 再断开）在之后异步经 onError 回调，
            // try/catch 根本包不住 —— 那种情况只会弹提示，**不会**自动回退本地。
            //
            // 没做"WS 失败自动切本地"是有意的：那时麦克风已经在采、用户可能已经在说，
            // 中途重连会丢掉开头、还要处理旧会话残留与重连风暴，风险大于收益。保持注释如实。
            addToast(t('input.speechCloudFallback'), 'info', 4000);
            session = await startAsrStream(asrHandlers, { engine: 'local', model: speechInputLocalModel });
          }
        } else {
          session = await startAsrStream(asrHandlers, { engine: 'local', model: speechInputLocalModel });
        }
      } catch (err: any) {
        // 先看这一轮还算不算数：如果用户已经点了停止、甚至又重新开始了一轮，
        // 这个错误属于"上一次启动"，此时
        //   · 不该弹提示 —— 会把用户看懵（他眼前是新一轮在跑）；
        //   · 更不能 resetSpeechInput() —— 那会把**刚起来的新一轮**一起复位掉
        //     （active / anchor / 预览全被清），等于用户刚开口就被我们掐了。
        if (isStale()) return;
        addToast(err?.message || t('input.audioRecordingFailed'), 'error', 6000);
        resetSpeechInput();
        return;
      }
      if (isStale()) {
        // 接引擎这段时间里用户已经取消了（或又点了开始）：这一轮的连接不能再留着，
        // 否则它会变成一个没人收的孤儿连接。
        try { session.abort(); } catch { /* 已断开 */ }
        return;
      }
      speechSessionRef.current = session;

      // 2) 再开麦克风
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (isStale()) {
        // 等麦克风授权期间用户已经取消了 —— 别把已经开的流晾着
        // （授权弹窗可能停留很久，这期间用户完全可能点停止）
        stream.getTracks().forEach(track => track.stop());
        try { session.abort(); } catch { /* 已断开 */ }
        return;
      }
      // 让浏览器直接按 16kHz 采样；平台不认这个参数时给原生采样率，
      // 下面用线性插值重采样兜底。
      const audioContext = new AudioContextCtor({ sampleRate: SPEECH_SAMPLE_RATE });
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      const convert = createPcm16Converter(audioContext.sampleRate, SPEECH_SAMPLE_RATE);
      processor.onaudioprocess = (event) => {
        if (!speechAudioRef.current) return;
        const payload = convert(event.inputBuffer.getChannelData(0));
        if (payload) session.sendPcm(payload);
      };
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);
      speechAudioRef.current = { stream, audioContext, source, processor, silentGain };
      // 到这里才是真的在采集了（麦克风已开、处理器已接上）
      setSpeechInputState('listening');
      // 云端批式：录音要一直攒 PCM 到松手，必须有真实时长上限（见 MAX_BATCH_RECORDING_MS）。
      // 到点自动走"用户按停止"那条路（提示 + finish → 上传转写），不让用户一直录下去。
      // 用 ref 调 toggle：这一轮此刻必然 active，toggle 会走停止分支。
      if (speechInputEngine === 'cloud-batch') {
        speechMaxDurationTimerRef.current = window.setTimeout(() => {
          speechMaxDurationTimerRef.current = null;
          if (!speechActiveRef.current) return;   // 已经停了/取消了，别再动
          addToast(t('input.speechMaxDurationReached'), 'info', 6000);
          speechStopRef.current();
        }, MAX_BATCH_RECORDING_MS);
      }
    } catch (err) {
      console.warn('[input] failed to start speech input', err);
      addToast(t('input.audioRecordingFailed'), 'error', 6000);
      resetSpeechInput();
    }
  }, [addToast, applySpeechPartial, commitSpeechSegment, draftKey, editor, endSpeechInput, resetSpeechInput, speechInputBatchModel, speechInputCloudModel, speechInputEngine, speechInputLocalModel, t]);

  const handleSpeechInputToggle = useCallback(() => {
    // 用同步 ref 判断，避免连点穿透到 startSpeechInput
    if (speechActiveRef.current) {
      // 用户已经按过一次停止、正在收尾（转写中）——再点一次就是"立刻取消/收尾"：
      // 直接 endSpeechInput（会 abort 会话），不要让用户卡在"正在转写…"上。
      if (speechFinishRequestedRef.current) {
        endSpeechInput();
        return;
      }
      speechFinishRequestedRef.current = true;
      // 用户按停止 = 立即提交剩余预览（对应 final）：先停采集，再让引擎把剩余
      // 音频解完，final 回来时提交。兜底计时器防止引擎不回声时界面卡在"正在转写…"。
      const session = speechSessionRef.current;
      stopSpeechAudio();
      // 采集停了，自动停止计时器也就没意义了；撤掉，免得它稍后误触发"再停止一次"。
      if (speechMaxDurationTimerRef.current !== null) {
        window.clearTimeout(speechMaxDurationTimerRef.current);
        speechMaxDurationTimerRef.current = null;
      }
      if (session) {
        // 补一小段静音再收尾：ScriptProcessor 的缓冲区里还有最多约 0.25 秒音频没送出去，
        // 直接 finish 会让最后一个字被截断。静音既把管道顶一遍，也给引擎的端点检测
        // 一个「句子结束了」的信号（多数流式引擎靠静音判定句尾）。
        try {
          session.sendPcm(new ArrayBuffer(Math.round(SPEECH_SAMPLE_RATE * 0.3) * 2));
        } catch { /* 已断开 */ }
        session.finish();
        // 采集已停、等引擎出结果 —— 界面从"聆听中"切到"正在转写…"。
        // final / 超时兜底 / 出错都会走 endSpeechInput → resetSpeechInput 把它收回 idle。
        setSpeechInputState('transcribing');
        if (speechFinalTimerRef.current !== null) window.clearTimeout(speechFinalTimerRef.current);
        // 兜底计时器：防止引擎不回声时界面卡在"正在转写…"。
        // 云端批式要上传 + 转写，比流式慢得多（几秒到十几秒），给足时间；
        // 流式引擎正常几百毫秒就回 final，5 秒足够。
        speechFinalTimerRef.current = window.setTimeout(() => {
          speechFinalTimerRef.current = null;
          endSpeechInput();
        }, speechInputEngine === 'cloud-batch' ? 60_000 : 5000);
      } else {
        endSpeechInput();
      }
      return;
    }
    void startSpeechInput();
  }, [endSpeechInput, speechInputEngine, startSpeechInput, stopSpeechAudio]);

  // 把 toggle 挂到 ref 上，供批式自动停止计时器（定义在 startSpeechInput 里）回调。
  useEffect(() => { speechStopRef.current = handleSpeechInputToggle; }, [handleSpeechInputToggle]);

  // 切会话、输入被锁定（只读会话）时强制收尾 —— 这两种都算"用户终止了语音输入"，
  // 把待定内容提交进文档（提交 ≠ 发送，落到输入框后用户还能自己改）。
  // 注意切会话要写到**上一个会话**的草稿里，所以把开始时的 key 传过去。
  //
  // 依赖里**故意只放真正的触发条件**，不放 endSpeechInput：它的身份会随 draftKey/editor
  // 变化，一旦放进去，任何无关的重渲染都可能触发"提前收尾"，把正在进行的语音掐掉。
  const endSpeechInputRef = useRef<typeof endSpeechInput | null>(null);
  useEffect(() => { endSpeechInputRef.current = endSpeechInput; }, [endSpeechInput]);

  useEffect(() => {
    if (!speechActiveRef.current) return;
    endSpeechInputRef.current?.(undefined, speechDraftKeyRef.current ?? undefined);
  }, [currentSessionPath, inputLocked]);

  // 语音识别是否启用 —— 决定新按钮是否出现（与对话模型无关）
  useEffect(() => {
    let cancelled = false;
    if (!connected) {
      setSpeechInputEnabled(false);
      return undefined;
    }
    // 用 async 包一层：这样任何实现层面的失败（返回非 Promise、响应不可解析）
    // 都会被下面的 catch 吃掉，不会变成 effect 里的同步异常。
    const load = async () => {
      try {
        const res = await hanaFetch('/api/speech-recognition/providers');
        const data = await res.json();
        // 用独立的「语音输入」开关判断，而不是「发送语音条时转录」——
        // 两者是不同功能。字段缺失按开启处理（默认开）。
        if (!cancelled) {
          setSpeechInputEnabled(data?.config?.inputEnabled !== false);
          setSpeechInputEngine(data?.config?.inputEngine || 'local');
          setSpeechInputLocalModel(data?.config?.inputLocalModel || 'zh-14M');
          // 云端批式专属模型：与作者的「语音条转录模型」无关，没配就是 null
          const batchModel = data?.config?.inputBatchModel;
          setSpeechInputBatchModel(
            batchModel?.provider && batchModel?.id
              ? { provider: String(batchModel.provider), id: String(batchModel.id) }
              : null,
          );
          // 云端流式选中的实时模型：没配（或选了空）就交给服务端用默认型号
          const cloudModel = data?.config?.inputCloudModel;
          setSpeechInputCloudModel(
            cloudModel?.provider && cloudModel?.id
              ? { provider: String(cloudModel.provider), id: String(cloudModel.id) }
              : null,
          );
        }
      } catch {
        if (!cancelled) setSpeechInputEnabled(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [connected, settingsModalOpen]);

  // 组件卸载（关窗口 / 切页面）：编辑器马上就没了，没法正常插入，
  // 所以把还没提交的预览直接并进该会话的草稿里 —— 下次打开还能看到，不丢字。
  // 然后收干净麦克风与识别流，避免麦克风指示灯不灭、连接泄漏。
  useEffect(() => () => {
    const ed = editor;
    const key = speechDraftKeyRef.current;
    if (speechActiveRef.current && ed && !ed.isDestroyed && key) {
      const preview = speechPreviewKey.getState(ed.state)?.text ?? '';
      if (preview) {
        const state = useStore.getState() as any;
        const prev = sessionScopedValue(state, state.drafts, key) || '';
        setDraft(key, prev + preview, undefined);
      }
    }
    stopSpeechAudio();
    closeSpeechSession();
  }, [closeSpeechSession, editor, setDraft, stopSpeechAudio]);

  // 切换 session / 回到首页 / 草稿 hydrate 完成时恢复草稿
  const draftsHydratedAt = useStore(s => s.draftsHydratedAt);
  const draftText = useStore(s => (
    draftKey ? (sessionScopedValue(s, s.drafts, draftKey) || '') : ''
  ));
  const draftDoc = useStore(s => (
    draftKey ? sessionScopedValue(s, s.draftDocs, draftKey) : undefined
  ));
  useEffect(() => {
    if (!editor || !draftKey) return;
    const draft = draftText;
    const draftDocValue = draftDoc;
    const currentDoc = editor.getJSON();
    // 文档存在性以 draftDoc 为准，text 仅是无 doc 时的降级；skillBadge 等 atom
    // 节点序列化文本为空，用 text 真值判存在会把刚插入的 badge 误删（#2101 skill
    // 消失回归，触发链 848481a69）。
    const nextDoc = draftDocValue ?? (draft ? plainTextToEditorDocument(draft) : null);
    const currentSerialized = serializeEditor(currentDoc).text;
    const nextSerialized = draft;
    const currentDocJson = JSON.stringify(currentDoc);
    const nextDocJson = nextDoc ? JSON.stringify(nextDoc) : '';
    if (nextSerialized !== currentSerialized || nextDocJson !== currentDocJson) {
      // 程序性写入必须走 applyComposerDocument：写 editor 后回读同步镜像（#2101）
      applyComposerDocument(editor, nextDoc, setInputText);
    } else {
      // 文档已一致时仍回读一次，修复历史 emitUpdate:false 留下的镜像脱节
      syncComposerMirrorFromEditor(editor, setInputText);
    }
  }, [editor, draftKey, draftText, draftDoc, draftsHydratedAt]);

  // 点击外部关闭斜杠菜单
  useEffect(() => {
    if (!slashMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (slashMenuRef.current?.contains(e.target as Node)) return;
      if (slashBtnRef.current?.contains(e.target as Node)) return;
      dismissSlashMenu();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dismissSlashMenu, slashMenuOpen]);

  useEffect(() => {
    if (!fileMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (fileMenuRef.current?.contains(e.target as Node)) return;
      setFileMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [fileMenuOpen]);

  // Can send?
  const hasContent = !composerPayloadIsEmpty({
    hasText: inputText.trim().length > 0,
    hasFiles: attachedFiles.length > 0 || editorHasInlineNode(editor, 'fileBadge'),
    hasSkills: editorHasInlineNode(editor, 'skillBadge'),
    hasMentions: editorHasInlineNode(editor, 'sessionBadge') || editorHasInlineNode(editor, 'agentBadge'),
    hasDocContext: docContextAttached,
    hasQuotes: quotedSelections.length > 0,
  });
  // capabilityRefreshing / compacting：压缩到 reload 完成之间 session 没有可用
  // runtime，此窗口内发 prompt 会冷建第二个 runtime 与 reload 竞争（#1624 I2）。
  const canSend = hasContent && connected && !isStreaming && !modelSwitching && !pendingSessionSwitchPath && !inputLocked
    && !modelSelectionRequired
    && !capabilityRefreshing && !compacting;

  const loadVisionAuxiliaryConfig = useCallback(async () => {
    if (surface === 'mobile') {
      const res = await hanaFetch('/api/models/auxiliary-vision');
      const data = await res.json();
      const auxiliaryVision = data?.auxiliaryVision;
      return {
        enabled: auxiliaryVision?.available === true,
        model: auxiliaryVision?.model || null,
      };
    }
    const res = await hanaFetch('/api/preferences/models');
    const data = await res.json();
    return {
      enabled: data?.models?.vision_enabled === true,
      model: data?.models?.vision || null,
    };
  }, [surface]);

  // ── Paste attachments ──
  // 剪贴板里能解析出文件系统路径的 file item 直接复用拖拽附件注册。
  // 无路径图片 blob 才上传到 session-files，入 store 时保持 path-backed 附件形态。
  const handlePaste = useCallback((e: ClipboardEvent): boolean => {
    if (inputLocked) {
      e.preventDefault();
      return true;
    }
    const items = e.clipboardData?.items;
    if (items) {
      const pathItems: string[] = [];
      const nameMap: Record<string, string> = {};
      for (const item of Array.from(items)) {
        if (item.kind && item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (!file) continue;
        const filePath = window.platform?.getFilePath?.(file);
        if (!filePath) continue;
        pathItems.push(filePath);
        nameMap[filePath] = file.name;
      }
      if (pathItems.length > 0) {
        e.preventDefault();
        void Promise.resolve(attachFilesFromPaths(pathItems, nameMap)).catch((err) => {
          console.warn('[paste] attach clipboard file paths failed', err);
        });
        return true;
      }

      for (const item of Array.from(items)) {
        if (!item.type.startsWith('image/')) continue;
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) return true;
        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = reader.result as string;
          const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
          if (!match) return;
          const [, mimeType, base64Data] = match;
          const ext = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : (mimeType.split('/')[1] || 'png');
          const name = `${t('input.pastedImage')}.${ext}`;
          try {
            const uploadPayload = await prepareChatImageUpload({
              file,
              name,
              base64Data,
              mimeType,
            });
            const res = await hanaFetch('/api/upload-blob', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: uploadPayload.name,
                base64Data: uploadPayload.base64Data,
                mimeType: uploadPayload.mimeType,
                ...(useStore.getState().currentSessionPath ? { sessionPath: useStore.getState().currentSessionPath } : {}),
              }),
            });
            const data = await res.json();
            const upload = data?.uploads?.[0];
            if (upload?.dest) {
              addAttachedFile({ fileId: upload.fileId, path: upload.dest, name: upload.name || uploadPayload.name, isDirectory: false });
            } else {
              notifyPasteUploadFailure(t, upload?.error);
              console.warn('[paste] upload-blob failed', upload?.error || data);
            }
          } catch (err) {
            notifyPasteUploadFailure(t, err);
            console.warn('[paste] upload-blob error', err);
          }
        };
        reader.readAsDataURL(file);
        return true;
      }
    }

    const plainUrlPaste = extractPlainUrlPaste(e.clipboardData);
    if (plainUrlPaste && editor) {
      e.preventDefault();
      editor.commands.insertContent(plainUrlPaste);
      return true;
    }
    return false;
  }, [addAttachedFile, editor, inputLocked, t]);

  pasteHandlerRef.current = handlePaste;

  // ── Load thinking level once server port is ready + listen for plan mode sync ──
  const activeServerConnection = useStore(s => s.activeServerConnection);
  useEffect(() => {
    if (activeServerConnection && surface !== 'mobile') {
      const query = pendingNewSession
        ? '?pendingNewSession=1'
        : currentSessionPath
          ? `?sessionPath=${encodeURIComponent(currentSessionPath)}`
          : '';
      hanaFetch(`/api/session-thinking-level${query}`)
        .then(r => r.json())
        .then(d => { if (d.thinkingLevel) setThinkingLevel(d.thinkingLevel as ThinkingLevel); })
        .catch((err: unknown) => console.warn('[InputArea] load thinking level failed', err));
    }

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      setPermissionMode((detail.mode || (detail.enabled ? 'read_only' : 'operate')) as PermissionMode);
    };
    window.addEventListener('hana-plan-mode', handler);
    return () => window.removeEventListener('hana-plan-mode', handler);
  }, [activeServerConnection, currentSessionPath, pendingNewSession, setPermissionMode, setThinkingLevel, surface]);

  // ── Handle slash selection (builtin vs skill) ──
  const handleSlashSelect = useCallback((item: SlashItem) => {
    if (inputLocked) return;
    slashDismissedTextRef.current = null;
    const slashText = editor?.getText().trim() || inputText.trim();
    if (item.type === 'builtin') {
      item.execute(slashText);
      return;
    }
    if (item.type === 'server-command') {
      void executeSlashViaWs(
        item.name,
        slashAgentId,
        setSlashBusy,
        () => { editor?.commands.clearContent(); },
        setSlashMenuOpen,
      )(applySlashCompletion(slashText, item));
      return;
    }
    if (!editor) return;
    const slashRange = findSlashTriggerRange(editor);
    const chain = editor.chain().focus();
    if (slashRange) {
      chain.deleteRange({ from: slashRange.from, to: slashRange.to });
    }
    chain
      .insertContent({ type: 'skillBadge', attrs: { name: item.name } })
      .insertContent(' ')
      .run();
    setSlashMenuOpen(false);
  }, [editor, inputLocked, inputText, slashAgentId]);

  const handleFileMentionSelect = useCallback((item: FileMentionItem) => {
    if (inputLocked) return;
    if (!editor || !fileMentionRange) return;
    editor.chain()
      .focus()
      .deleteRange({ from: fileMentionRange.from, to: fileMentionRange.to })
      .insertContent({
        type: 'fileBadge',
        attrs: {
          fileId: item.fileId || null,
          path: item.path,
          name: item.name,
          isDirectory: !!item.isDirectory,
          mimeType: item.mimeType || null,
        },
      })
      .insertContent(' ')
      .run();
    setFileMenuOpen(false);
    setFileMentionRange(null);
    setFileMentionQuery('');
  }, [editor, fileMentionRange, inputLocked]);

  const handleMentionSelect = useCallback((item: MentionMenuItem) => {
    if ('kind' in item && item.kind === 'session') {
      if (inputLocked || !editor || !fileMentionRange) return;
      editor.chain()
        .focus()
        .deleteRange({ from: fileMentionRange.from, to: fileMentionRange.to })
        .insertContent({ type: 'sessionBadge', attrs: { sessionId: item.sessionId, label: item.name } })
        .insertContent(' ')
        .run();
      setFileMenuOpen(false);
      setFileMentionRange(null);
      setFileMentionQuery('');
      return;
    }
    if ('kind' in item && item.kind === 'agent') {
      if (inputLocked || !editor || !fileMentionRange) return;
      if (editorHasInlineNode(editor, 'agentBadge')) {
        addToast(t('input.mention.singleAgent'), 'warning', 5000);
        return;
      }
      editor.chain()
        .focus()
        .deleteRange({ from: fileMentionRange.from, to: fileMentionRange.to })
        .insertContent({ type: 'agentBadge', attrs: { agentId: item.agentId, label: item.name } })
        .insertContent(' ')
        .run();
      setFileMenuOpen(false);
      setFileMentionRange(null);
      setFileMentionQuery('');
      return;
    }
    handleFileMentionSelect(item as FileMentionItem);
  }, [addToast, editor, fileMentionRange, handleFileMentionSelect, inputLocked, t]);

  // ── Send / interject message ──
  const submitEditorMessage = useCallback(async (type: 'prompt' | 'interject') => {
    if (inputLocked) return;
    if (!editor) return;
    // 语音输入还在进行时按发送：**未落定的那句只存在于预览层**（预览故意不写进文档，
    // 免得高频 partial 搅乱撤销历史），而下面的 text 只从文档取 —— 不先提交就等于把
    // 用户刚说出口的那句丢掉。所以这里先把预览落进文档，再走原来的发送流程。
    // 代价：这一小段的标点/数字规整用的是引擎已给的原始预览（来不及等 final 回来）。
    if (speechActiveRef.current) {
      stopSpeechAudio();
      closeSpeechSession();
      commitSpeechSegment();
      speechAnchorRef.current = null;
      speechDraftKeyRef.current = null;
      speechActiveRef.current = false;
      setSpeechInputState('idle');
    }
    const editorJson = editor.getJSON();
    const { text: rawText, skills, fileRefs, sessionRefs, agentMentions } = serializeEditor(editorJson);
    const text = rawText.trim();
    const clickState = useStore.getState();
    const clickedPendingDraftId = clickState.pendingNewSession ? clickState.pendingDraftId : null;
    const clickedSessionPath = clickState.currentSessionPath;
    const clickedProjection = clickedSessionPath
      ? clickState.sessions.find(session => session.path === clickedSessionPath)
      : null;
    const clickedSessionId = clickState.currentSessionId || clickedProjection?.sessionId || null;
    const clickedAgentId = clickedProjection?.agentId || clickState.currentAgentId || null;
    const clickedSessionRef: Readonly<SessionRef> | null = clickedSessionPath && clickedSessionId && clickedAgentId
      ? Object.freeze({ sessionId: clickedSessionId, sessionPath: clickedSessionPath, agentId: clickedAgentId })
      : null;
    const clickedAttachedFiles = attachedFiles.map(file => ({ ...file }));
    const clickedQuotes = clickState.quotedSelections.map(quote => ({ ...quote }));
    const clickedDocContextAttached = docContextAttached;
    const clickedDoc = currentDoc ? { ...currentDoc } : null;
    const clickedUiContext = collectUiContext(clickState);

    if (agentMentions.length > 1) {
      addToast(t('input.mention.singleAgent'), 'warning', 5000);
      return;
    }
    if (type === 'interject' && agentMentions.length > 0) {
      addToast(t('agentReview.interjectionUnavailable'), 'warning', 5000);
      return;
    }

    if (type === 'prompt') {
      const slashSelection = resolveSlashSubmitSelection({
        text,
        skills,
        commands: slashCommands,
        selectedIndex: slashSelected,
        dismissedText: slashDismissedTextRef.current,
      });
      if (slashSelection) {
        handleSlashSelect(slashSelection);
        return;
      }
    }

    const inputFiles = mergeEditorFileRefs(clickedAttachedFiles, fileRefs);
    const hasFiles = inputFiles.length > 0;
    // 空输入静默 return 是合理行为（不是错误），不加 toast；与按钮侧 hasContent 共用同一份谓词（#2101）。
    if (composerPayloadIsEmpty({
      hasText: !!text,
      hasFiles,
      hasSkills: skills.length > 0,
      hasMentions: sessionRefs.length > 0 || agentMentions.length > 0,
      hasDocContext: clickedDocContextAttached,
      hasQuotes: clickedQuotes.length > 0,
    }) || !connected) return;
    if (type === 'prompt' && isStreaming) return;
    if (type === 'interject' && !isStreaming) return;
    if (sending) return;
    if (modelSwitching) return;
    if (useStore.getState().pendingSessionSwitchPath) return;
    const guardState = useStore.getState();
    const guardModel = guardState.currentSessionPath
      ? sessionScopedValue(guardState, guardState.sessionModelsByPath, guardState.currentSessionPath)
      : undefined;
    if (guardModel?.available === false) {
      guardState.addToast(
        t(modelUnavailableMessageKey(guardModel.unavailableReason)),
        'warning',
        6000,
        { dedupeKey: 'session-model-unavailable' },
      );
      return;
    }
    if (type === 'prompt') {
      // 压缩 / 能力刷新（fresh compact）期间禁发 prompt：此窗口内 session 没有
      // 可用 runtime，发消息会冷建第二个 runtime 与压缩后的 reload 竞争（#1624 I2）。
      // Enter 发送不走 canSend，必须在提交路径同样拦截；按 keyed 状态现读现查。
      const guardState = useStore.getState();
      const guardPath = guardState.currentSessionPath;
      if (guardPath && (
        sessionScopedListIncludes(guardState, guardState.capabilityRefreshingSessions, guardPath)
        || isSessionCompacting(guardState, guardPath)
      )) return;
    }
    setSending(true);

    try {
      let sessionRef = clickedSessionRef;
      if (clickedPendingDraftId) {
        sessionRef = await ensureSession(clickedPendingDraftId);
        if (!sessionRef) {
          // ensureSession 拿不到会话身份：不能静默吞掉这次发送，否则用户会以为点了没反应（#2101）。
          useStore.getState().addToast(t('error.noActiveSession'), 'error', 6000, {
            dedupeKey: 'send-missing-session',
          });
          return;
        }
        loadSessions();
      }
      if (!sessionRef) {
        // 走到这里说明既不是 pending 新会话、也没有已激活会话身份——同样是无法发送，显式报错而非静默 return。
        useStore.getState().addToast(t('error.noActiveSession'), 'error', 6000, {
          dedupeKey: 'send-missing-session',
        });
        return;
      }

      // 分离原生媒体和普通附件；后端决定图片视觉桥、视频/音频原生能力或显式报错。
      const imageFiles = hasFiles ? inputFiles.filter(f => !f.isDirectory && isImageFile(f.name)) : [];
      const videoFiles = hasFiles ? inputFiles.filter(f => !f.isDirectory && isVideoFile(f.name)) : [];
      const audioFiles = hasFiles ? inputFiles.filter(f => !f.isDirectory && isAudioFileName(f.name, f.mimeType)) : [];

      const imagePreflight = await evaluateChatImageSendPreflight({
        attachments: inputFiles,
        model: currentModelInfo,
        loadVisionAuxiliaryConfig,
      });
      // #1647：视觉能力不可用不再拦下整条消息。图片始终携带文件身份
      //（displayMessage.attachments → 服务端登记 SessionFile + 注入路径 marker），
      // 这里只决定是否附带像素载荷；降级是显式的（toast 告知 + 不读字节）。
      const imagesAsFileOnly = !imagePreflight.ok;
      if (imagesAsFileOnly) {
        notifyTextModelImageFileOnly({
          t,
          addToast: useStore.getState().addToast,
          openSettings: () => openProviderModelSettings(currentModelInfo?.provider),
        });
      }
      const videoPreflight = await evaluateChatVideoSendPreflight({
        attachments: inputFiles,
        model: currentModelInfo,
      });
      const sendVideosNatively = videoPreflight.ok && videoPreflight.reason === 'native-video';
      const videosAsFileOnly = !videoPreflight.ok;
      if (videosAsFileOnly) {
        notifyTextModelVideoFileOnly({
          t,
          addToast: useStore.getState().addToast,
          openSettings: () => openProviderModelSettings(currentModelInfo?.provider),
        });
      }
      const audioPreflight = await evaluateChatAudioSendPreflight({
        attachments: inputFiles,
        model: currentModelInfo,
      });
      const sendAudiosNatively = audioPreflight.ok && audioPreflight.reason === 'native-audio';
      const otherFiles = hasFiles ? inputFiles.filter(f =>
        f.isDirectory || (
          !isImageFile(f.name)
          && !(sendVideosNatively && isVideoFile(f.name))
          && !(sendAudiosNatively && isAudioFileName(f.name, f.mimeType))
        )
      ) : [];

      const sessionPathForSend = sessionRef.sessionPath;
      const sessionFileRefs = otherFiles
        .filter(f => f.fileId)
        .map(f => ({
          fileId: f.fileId,
          sessionId: sessionRef.sessionId,
          sessionPath: sessionPathForSend,
          label: f.name || f.path,
          kind: f.isDirectory ? 'directory' : 'attachment',
        }));

      let finalText = text;
      if (otherFiles.length > 0) {
        const fileBlock = otherFiles.map(f => {
          const label = f.fileId ? (f.name || f.path) : f.path;
          return f.isDirectory
            ? t('input.attachmentDirectory', { label })
            : t('input.attachmentFile', { label });
        }).join('\n');
        finalText = text ? `${text}\n\n${fileBlock}` : fileBlock;
      }

      // 图片 / 视频读 base64。统一走 platform 层：Electron 里 platform 代理到 hana，
      // Web/PWA 里 platform 代理到 HTTP fallback。
      const platform = window.platform;
      const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
      const videos: Array<{ type: 'video'; data: string; mimeType: string }> = [];
      const audios: Array<{ type: 'audio'; data: string; mimeType: string }> = [];
      const imageBase64Map = new Map<string, { base64Data: string; mimeType: string }>();
      const videoBase64Map = new Map<string, { base64Data: string; mimeType: string }>();
      const audioBase64Map = new Map<string, { base64Data: string; mimeType: string }>();
      // 单图读取失败同样不拦整条消息：该图退化为仅文件身份，显式提示（#1647）
      const imageFileOnlyPaths = new Set<string>();
      for (const img of imagesAsFileOnly ? [] : imageFiles) {
        try {
          if (img.base64Data && img.mimeType) {
            images.push({ type: 'image', data: img.base64Data, mimeType: img.mimeType });
          } else {
            const base64 = await platform?.readFileBase64?.(img.path);
            if (base64) {
              const mimeType = chatImageMimeTypeForName(img.name, img.mimeType);
              imageBase64Map.set(img.path, { base64Data: base64, mimeType });
              images.push({ type: 'image', data: base64, mimeType });
            } else {
              throw new Error(`failed to read image attachment: ${img.path}`);
            }
          }
        } catch (err) {
          console.warn('[input] failed to read image attachment', err);
          imageFileOnlyPaths.add(img.path);
          useStore.getState().addToast(t('input.imageReadFailedSentAsFile'), 'warning', 6000, {
            dedupeKey: `image-read-failed:${img.path}`,
          });
        }
      }
      for (const audio of sendAudiosNatively ? audioFiles : []) {
        try {
          if (audio.base64Data) {
            const mimeType = chatAudioMimeTypeForName(audio.name, audio.mimeType);
            audios.push({ type: 'audio', data: audio.base64Data, mimeType });
          } else {
            const base64 = await platform?.readFileBase64?.(audio.path);
            if (base64) {
              const mimeType = chatAudioMimeTypeForName(audio.name, audio.mimeType);
              audioBase64Map.set(audio.path, { base64Data: base64, mimeType });
              audios.push({ type: 'audio', data: base64, mimeType });
            } else {
              throw new Error(`failed to read audio attachment: ${audio.path}`);
            }
          }
        } catch (err) {
          console.warn('[input] failed to read audio attachment', err);
          useStore.getState().addToast(t('input.audioReadFailed'), 'error', 6000, {
            dedupeKey: `audio-read-failed:${audio.path}`,
          });
          return;
        }
      }
      for (const video of sendVideosNatively ? videoFiles : []) {
        try {
          if (video.base64Data && video.mimeType) {
            const mimeType = chatVideoMimeTypeForName(video.name, video.mimeType);
            videos.push({ type: 'video', data: video.base64Data, mimeType });
          } else {
            const base64 = await platform?.readFileBase64?.(video.path);
            if (base64) {
              const mimeType = chatVideoMimeTypeForName(video.name, video.mimeType);
              videoBase64Map.set(video.path, { base64Data: base64, mimeType });
              videos.push({ type: 'video', data: base64, mimeType });
            } else {
              throw new Error(`failed to read video attachment: ${video.path}`);
            }
          }
        } catch (err) {
          console.warn('[input] failed to read video attachment', err);
          useStore.getState().addToast(t('input.videoReadFailed'), 'error', 6000, {
            dedupeKey: `video-read-failed:${video.path}`,
          });
          return;
        }
      }

      // 文档上下文
      let docForRender: { path: string; name: string } | null = null;
      if (clickedDocContextAttached && clickedDoc) {
        finalText = finalText
          ? `${finalText}\n\n${t('input.referenceDocument', { path: clickedDoc.path })}`
          : t('input.referenceDocument', { path: clickedDoc.path });
        docForRender = clickedDoc;
      }

      // 引用片段
      const quotes = clickedQuotes;
      if (quotes.length > 0) {
        const quoteStr = quotes.map(formatQuotedSelectionForPrompt).join('\n\n');
        finalText = finalText ? `${finalText}\n\n${quoteStr}` : quoteStr;
      }

      const allFiles = [...(hasFiles ? inputFiles : [])];
      if (docForRender) allFiles.push({ path: docForRender.path, name: docForRender.name });

      const beforeCleanup = useStore.getState();
      const stillOwnsPendingComposer = !!clickedPendingDraftId
        && beforeCleanup.pendingNewSession === true
        && beforeCleanup.pendingDraftId === clickedPendingDraftId;
      const stillOwnsComposer = stillOwnsPendingComposer || (
        beforeCleanup.currentSessionId === sessionRef.sessionId
        && beforeCleanup.currentSessionPath === sessionRef.sessionPath
      );
      clearDraft(sessionRef.sessionPath);
      clearAttachedFilesForSession(sessionRef.sessionPath);
      if (clickedPendingDraftId && beforeCleanup.pendingDraftId === clickedPendingDraftId) {
        clearDraft(HOME_DRAFT_KEY);
      }
      if (stillOwnsComposer) {
        editor.commands.clearContent();
        if (stillOwnsPendingComposer) clearAttachedFiles();
        if (clickedDocContextAttached) setDocContextAttached(false);
        if (clickedQuotes.length > 0) useStore.getState().clearQuotedSelections();
      }

      const clientMessageId = createClientUserMessageId();
      const displayMessage = {
        text,
        skills: skills.length > 0 ? skills : undefined,
        quotedText: quotes.length > 0 ? quotes.map(q => q.text).join('\n\n') : undefined,
        sessionRefs: sessionRefs.length > 0 ? sessionRefs : undefined,
        agentMentions: agentMentions.length > 0 ? agentMentions : undefined,
        attachments: allFiles.length > 0 ? allFiles.map(f => {
          const cached = imageBase64Map.get(f.path);
          const cachedVideo = videoBase64Map.get(f.path);
          const cachedAudio = audioBase64Map.get(f.path);
          const imageFile = !f.isDirectory && isImageFile(f.name);
          return {
            fileId: f.fileId,
            path: f.path,
            name: f.name,
            isDir: !!f.isDirectory,
            mimeType: f.mimeType || cached?.mimeType || cachedVideo?.mimeType || cachedAudio?.mimeType || undefined,
            visionAuxiliary: imageFile && !supportsVision && !imagesAsFileOnly && !imageFileOnlyPaths.has(f.path),
            ...(f.waveform ? { waveform: f.waveform } : {}),
          };
        }) : undefined,
      };

      useStore.getState().appendOptimisticUserMessage(sessionPathForSend, {
        id: clientMessageId,
        role: 'user',
        text,
        textHtml: text ? renderMarkdown(text) : undefined,
        timestamp: Date.now(),
        attachments: displayMessage.attachments,
        quotedText: displayMessage.quotedText,
        skills: displayMessage.skills,
        sendStatus: 'pending',
        agentReview: agentMentions.length === 1 ? {
          status: 'running',
          reviewerAgentId: agentMentions[0].agentId,
          reviewerAgentName: agentMentions[0].label,
        } : undefined,
      });

      const ws = getWebSocket();
      const wsMsg: Record<string, unknown> = {
        type,
        clientMessageId,
        text: finalText,
        sessionId: sessionRef.sessionId,
        sessionPath: sessionPathForSend,
        uiContext: clickedUiContext,
        displayMessage,
      };
      if (sessionFileRefs.length > 0) wsMsg.sessionFileRefs = sessionFileRefs;
      if (images.length > 0) wsMsg.images = images;
      if (videos.length > 0) wsMsg.videos = videos;
      if (audios.length > 0) wsMsg.audios = audios;
      if (skills.length > 0) wsMsg.skills = skills;
      if (sessionRefs.length > 0) wsMsg.sessionRefs = sessionRefs;
      if (agentMentions.length > 0) wsMsg.agentReviewRequests = agentMentions;
      if (!ws) {
        useStore.getState().markOptimisticUserMessageFailed(
          sessionPathForSend,
          clientMessageId,
          'websocket_unavailable',
        );
        return;
      }
      try {
        ws.send(JSON.stringify(wsMsg));
        upsertOptimisticSessionFirstMessage(sessionPathForSend, text, new Date().toISOString());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        useStore.getState().markOptimisticUserMessageFailed(sessionPathForSend, clientMessageId, message);
        throw err;
      }
    } finally {
      setSending(false);
    }
  }, [addToast, editor, inputLocked, attachedFiles, docContextAttached, connected, isStreaming, sending, currentDoc, clearAttachedFiles, clearAttachedFilesForSession, clearDraft, closeSpeechSession, commitSpeechSegment, stopSpeechAudio, setDocContextAttached, slashCommands, slashSelected, handleSlashSelect, supportsVision, currentModelInfo, loadVisionAuxiliaryConfig, modelSwitching, t]);

  const handleSend = useCallback(async () => {
    await submitEditorMessage('prompt');
  }, [submitEditorMessage]);

  // ── Steer ──
  const handleSteer = useCallback(async () => {
    await submitEditorMessage('interject');
  }, [submitEditorMessage]);

  // ── Stop ──
  const handleStop = useCallback(() => {
    const ws = getWebSocket();
    if (!isStreaming || !ws) return;
    const state = useStore.getState();
    const path = state.currentSessionPath;
    const sessionId = state.currentSessionId;
    const active = path ? sessionScopedValue(state, state.activeSessionStreams, path) : null;
    const request = createStopRequest({ sessionId, sessionPath: path, streamId: active?.streamId });
    if (!request) return;
    ws.send(JSON.stringify(request));
  }, [isStreaming]);

  // ── Key handler ──
  const handleEditorKeyDown = useCallback((e: InputKeyEvent): boolean => {
    if (inputLocked) {
      e.preventDefault();
      return true;
    }
    if (e.defaultPrevented) return false;
    if (fileMenuOpen) {
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        const tabs: MentionTab[] = ['files', 'sessions', 'agents'];
        const direction = e.key === 'ArrowRight' ? 1 : -1;
        setMentionTab(tabs[(tabs.indexOf(mentionTab) + direction + tabs.length) % tabs.length]);
        setFileSelected(0);
        return true;
      }
      if (e.key === 'ArrowDown' && mentionItems.length > 0) {
        e.preventDefault();
        setFileSelected(i => (i + 1) % mentionItems.length);
        return true;
      }
      if (e.key === 'ArrowUp' && mentionItems.length > 0) {
        e.preventDefault();
        setFileSelected(i => (i - 1 + mentionItems.length) % mentionItems.length);
        return true;
      }
      if ((e.key === 'Tab' || e.key === 'Enter') && mentionItems.length > 0) {
        e.preventDefault();
        const item = mentionItems[fileSelected];
        if (item) handleMentionSelect(item);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setFileMenuOpen(false);
        return true;
      }
    }
    if (slashMenuOpen && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSelected(i => (i + 1) % filteredCommands.length); return true; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSelected(i => (i - 1 + filteredCommands.length) % filteredCommands.length); return true; }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const cmd = filteredCommands[slashSelected] || filteredCommands[0];
        if (cmd) handleSlashSelect(cmd);
        return true;
      }
      if (e.key === 'Escape') { e.preventDefault(); dismissSlashMenu(); return true; }
    }
    if (e.key === 'Enter' && e.shiftKey && !isComposing.current && !e.isComposing && editor?.isActive('listItem')) {
      e.preventDefault();
      editor.commands.splitListItem('listItem');
      return true;
    }
    if (e.key === 'Enter' && !e.shiftKey && !isComposing.current && !e.isComposing) {
      e.preventDefault();
      if (isStreaming && hasContent) handleSteer(); else handleSend();
      return true;
    }
    return false;
  }, [
    dismissSlashMenu,
    editor,
    fileMentionBusy,
    mentionItems,
    mentionTab,
    fileMenuOpen,
    fileSelected,
    filteredCommands,
    handleMentionSelect,
    handleSend,
    handleSteer,
    handleSlashSelect,
    isStreaming,
    hasContent,
    inputLocked,
    slashMenuOpen,
    slashSelected,
  ]);

  keyDownHandlerRef.current = handleEditorKeyDown as (event: KeyboardEvent) => boolean;
  beforeInputHandlerRef.current = (event: InputEvent): boolean => {
    if (surface !== 'mobile') return false;
    if (event.defaultPrevented) return false;
    if (event.inputType !== 'insertParagraph') return false;
    return handleEditorKeyDown({
      key: 'Enter',
      shiftKey: false,
      defaultPrevented: event.defaultPrevented,
      isComposing: event.isComposing,
      preventDefault: () => event.preventDefault(),
    });
  };

  const handleSlashResultClick = useCallback(() => {
    if (slashResult?.filePath) {
      window.platform?.showInFinder?.(slashResult.filePath);
      return;
    }
    if (!slashResult?.deskDir) return;
    window.platform?.openFolder?.(slashResult.deskDir);
  }, [slashResult?.deskDir, slashResult?.filePath]);

  const handleContinueDeletedAgentSession = useCallback(async () => {
    const path = currentSessionPath;
    if (!path || continuingDeletedAgentSession) return;
    setDeletedAgentContinueError(null);
    setContinuingDeletedAgentSession(true);
    try {
      const ok = await continueDeletedAgentSession(path);
      if (!ok) setDeletedAgentContinueError(t('session.deletedAgent.continueFailed'));
    } catch (err) {
      console.warn('[input] continue deleted-agent session failed', err);
      setDeletedAgentContinueError(t('session.deletedAgent.continueFailed'));
    } finally {
      setContinuingDeletedAgentSession(false);
    }
  }, [continuingDeletedAgentSession, currentSessionPath, t]);

  return (
    <div
      className={`${styles['input-surface']}${surface === 'mobile' ? ` ${styles['input-surface-mobile']}` : ''}`}
      ref={inputSurfaceRef}
    >
      <InputContextRow
        attachedFiles={attachedFiles}
        removeAttachedFile={removeAttachedFile}
        hasQuotedSelection={quotedSelections.length > 0}
      />
      <InputStatusBars
        slashBusy={slashBusy}
        slashBusyLabel={slashCommands.find(c => c.name === slashBusy)?.busyLabel || t('common.executing')}
        compacting={compactingStatus}
        compactingLabel={compactingStatusLabel}
        screenshotBusy={screenshotBusy}
        screenshotLabel={t('common.screenshotInProgress')}
        screenshotPageLabel={screenshotProgress && screenshotProgress.totalPages > 0
          ? t('common.screenshotProgressPage', {
            current: screenshotProgress.currentPage,
            total: screenshotProgress.totalPages,
          })
          : null}
        screenshotProgress={screenshotProgress}
        inlineError={inlineError}
        modelUnavailableMessage={modelUnavailableMessage}
        slashResult={slashResult}
        onResultClick={(slashResult?.filePath || slashResult?.deskDir) ? handleSlashResultClick : undefined}
      />
      <div className={styles['slash-menu-anchor']} ref={slashMenuRef}>
        {slashMenuOpen && filteredCommands.length > 0 && (
          <SlashCommandMenu commands={filteredCommands} selected={slashSelected} busy={slashBusy}
            onSelect={handleSlashSelect} onHover={(i) => setSlashSelected(i)} />
        )}
      </div>
      <div className={styles['slash-menu-anchor']} ref={fileMenuRef}>
        {fileMenuOpen && (
          <MentionMenu
            tab={mentionTab}
            items={mentionItems}
            selected={fileSelected}
            busy={fileMentionBusy}
            agents={agents}
            onTabChange={(tab) => { setMentionTab(tab); setFileSelected(0); }}
            onSelect={handleMentionSelect}
            onHover={(i) => setFileSelected(i)}
          />
        )}
      </div>
      <div className={styles['input-stack']}>
        {visibleSessionConfirmation && (
          <SessionConfirmationPrompt
            block={visibleSessionConfirmation}
            exiting={sessionConfirmationExiting}
          />
        )}
        <div className={styles['input-wrapper']} ref={inputCardRef}>
          <input
            ref={browserFileInputRef}
            className={styles['browser-file-input']}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/gif,image/webp,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/ogg,audio/flac,audio/webm"
            disabled={inputLocked}
            onChange={handleBrowserFileInputChange}
          />
          <div
            onKeyDown={(event) => {
              if (!event.defaultPrevented) handleEditorKeyDown(event);
            }}
            onCompositionStart={() => { isComposing.current = true; }}
            onCompositionEnd={() => { isComposing.current = false; }}
          >
            <EditorContent editor={editor} />
          </div>
          <InputControlBar
            t={t}
            onAttach={handleAttach}
            slashBtnRef={slashBtnRef}
            onSlashToggle={handleSlashToggle}
            permissionMode={permissionMode}
            onPermissionModeChange={setPermissionMode}
            planModeLocked={inputLocked}
            showThinking={showThinkingControl}
            thinkingLevel={thinkingLevel}
            onThinkingChange={setThinkingLevel}
            availableThinkingLevels={availableThinkingLevels}
            models={models}
            sessionModel={sessionModel}
            isStreaming={isStreaming}
            hasInput={hasContent}
            canSend={canSend}
            showAudioInput={showAudioInput}
            audioRecordingActive={audioRecordingState === 'recording'}
            audioRecordingBusy={audioRecordingState === 'starting' || audioRecordingState === 'stopping'}
            onAudioToggle={handleAudioRecordToggle}
            speechInputEnabled={speechInputEnabled && !inputLocked}
            speechInputActive={speechInputState !== 'idle'}
            speechInputPhase={speechInputState}
            onSpeechInputToggle={handleSpeechInputToggle}
            onSend={handleSend}
            onSteer={handleSteer}
            onStop={handleStop}
          />
          {audioRecorderOpen && showAudioInput && (
            <div className={styles['audio-recording-card']} role="status" aria-live="polite">
              <div className={`${styles['audio-recording-dot']}${audioRecordingState === 'recording' ? ` ${styles['is-live']}` : ''}`} />
              <div className={styles['audio-recording-copy']}>
                <div className={styles['audio-recording-title']}>
                  {audioRecordingState === 'starting'
                    ? t('input.audioRecordingStarting')
                    : audioRecordingState === 'stopping'
                      ? t('input.audioRecordingSaving')
                      : t('input.audioRecording')}
                </div>
                <div className={styles['audio-recording-time']}>
                  {formatRecordingElapsed(audioRecordingElapsed)}
                </div>
                {audioRecordingError && (
                  <div className={styles['audio-recording-error']}>
                    {audioRecordingError}
                  </div>
                )}
              </div>
            </div>
          )}
          {deletedAgentReadOnly && (
            <div className={styles['deleted-agent-overlay']} role="status" aria-live="polite">
              <div className={styles['deleted-agent-panel']}>
                <div className={styles['deleted-agent-title']}>
                  {t('session.deletedAgent.title')}
                </div>
                <div className={styles['deleted-agent-text']}>
                  {t('session.deletedAgent.description')}
                </div>
                <button
                  type="button"
                  className={styles['deleted-agent-action']}
                  onClick={handleContinueDeletedAgentSession}
                  disabled={continuingDeletedAgentSession}
                >
                  {continuingDeletedAgentSession
                    ? t('session.deletedAgent.continuing')
                    : t('session.deletedAgent.continueButton')}
                </button>
                {continuingDeletedAgentSession && (
                  <div className={styles['deleted-agent-progress']} data-testid="deleted-agent-progress">
                    <div className={styles['deleted-agent-progress-fill']} />
                  </div>
                )}
                {deletedAgentContinueError && (
                  <div className={styles['deleted-agent-error']}>
                    {deletedAgentContinueError}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
