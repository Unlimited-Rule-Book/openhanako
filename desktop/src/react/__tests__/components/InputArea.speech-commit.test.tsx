// @vitest-environment jsdom
//
// 回归测试：句末提交必须用**引擎给的处理后文本**，不能用预览层的原始文本。
//
// 背景（真实踩过的坑）：引擎在 endpoint / final 事件里返回的是处理过的结果
// （已加标点、已把中文数字转成阿拉伯数字），而预览层里放的是**原始**识别结果。
// 第一版前端写成了 `onEndpoint: () => commitSpeechSegment()` —— 忽略事件参数、
// 直接提交预览，于是标点和数字规整全部白做，用户看到的永远是没有标点的原始稿。
//
// 这个测试就是钉死这一点：喂一个"原始"partial 和一个"处理后"的 endpoint，
// 断言最终写进文档的是**处理后**的那个。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputArea } from '../../components/InputArea';
import { useStore } from '../../stores';

// ── 记录插入到文档里的文本 ──
const editorMocks = vi.hoisted(() => ({
  inserted: [] as string[],
  dispatch: vi.fn(),
}));

const appMocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(),
  startAsrStream: vi.fn(),
  handlers: null as null | {
    onPartial?: (text: string, revision: boolean, segmentId: number) => void;
    onEndpoint?: (text: string, segmentId: number) => void;
    onFinal?: (payload: { text: string; segments: string[]; pending: string }) => void;
    onError?: (message: string) => void;
  },
  session: { sendPcm: vi.fn(), finish: vi.fn(), abort: vi.fn() },
}));

vi.mock('@tiptap/react', () => ({
  EditorContent: () => null,
  useEditor: () => {
    const chain: Record<string, unknown> = {};
    // 关键：把真正插进文档的文本记下来（commitSpeechSegment 用的就是这个 API）
    chain.insertContentAt = vi.fn((_position: unknown, value: unknown) => {
      if (value && typeof value === 'object' && 'text' in (value as Record<string, unknown>)) {
        editorMocks.inserted.push(String((value as { text: unknown }).text));
      }
      return chain;
    });
    chain.insertContent = vi.fn(() => chain);
    chain.deleteRange = vi.fn(() => chain);
    chain.focus = vi.fn(() => chain);
    chain.clearContent = vi.fn(() => chain);
    chain.run = vi.fn();
    return {
      commands: { focus: vi.fn(), scrollIntoView: vi.fn(), setContent: vi.fn(), insertContent: vi.fn() },
      chain: () => chain,
      getJSON: () => ({ type: 'doc', content: [] }),
      getText: () => '',
      isDestroyed: false,
      state: {
        // InputArea 渲染期会问 doc 的这几件事，替身给全，避免"不是函数"
        doc: {
          content: { size: 10 },
          descendants: vi.fn(),
          nodeAt: vi.fn(() => null),
          textBetween: vi.fn(() => ''),
          childCount: 0,
          firstChild: null,
          lastChild: null,
        },
        selection: { from: 1, to: 1, empty: true },
        tr: { setMeta: vi.fn(() => ({})) },
      },
      view: { dispatch: editorMocks.dispatch },
      on: vi.fn(),
      off: vi.fn(),
      setEditable: vi.fn(),
    };
  },
}));

// insertContentAt 的调用要能被记录（上面 chain 里做不了，这里补一个显式 spy）
// 预览层插件本身不参与这个测试（我们只关心"提交哪段文本"），
// 但要把它导出的东西都补齐 —— input-editor-extensions.ts 会 import 那个 Extension。
vi.mock('../../components/input/speech-preview-extension', () => ({
  SpeechPreviewExtension: { name: 'speechPreview' },
  speechPreviewKey: { getState: () => undefined },
  setSpeechPreview: vi.fn(),
  clearSpeechPreview: vi.fn(),
}));

vi.mock('../../hooks/use-slash-items', () => ({
  useSkillSlashItems: () => [],
  useServerSlashCommandItems: () => [],
}));
vi.mock('../../utils/paste-upload-feedback', () => ({ notifyPasteUploadFailure: vi.fn() }));
vi.mock('../../services/stream-resume', () => ({
  replayStreamResume: vi.fn(),
  isStreamResumeRebuilding: () => null,
  isStreamScopedMessage: () => false,
  updateSessionStreamMeta: vi.fn(),
  // websocket.ts 在模块加载时就会调这两个做依赖注入，缺了会直接报错
  injectHandlers: vi.fn(),
  injectWebSocketGetter: vi.fn(),
  requestStreamResume: vi.fn(),
}));
vi.mock('../../components/input/FileMentionMenu', () => ({ FileMentionMenu: () => null }));
vi.mock('../../components/input/InputStatusBars', () => ({ InputStatusBars: () => null }));
vi.mock('../../components/input/InputContextRow', () => ({ InputContextRow: () => null }));

// 语音输入按钮暴露成 testid，方便点击
vi.mock('../../components/input/InputControlBar', () => ({
  InputControlBar: ({ speechInputEnabled, onSpeechInputToggle }: {
    speechInputEnabled?: boolean;
    onSpeechInputToggle?: () => void;
  }) => (speechInputEnabled
    ? React.createElement('button', {
      type: 'button',
      'data-testid': 'speech-input',
      onClick: onSpeechInputToggle,
    }, 'speech')
    : null),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: appMocks.hanaFetch,
  hanaUrl: (p: string) => `http://127.0.0.1:3210${p}`,
}));

vi.mock('../../services/asr-stream', () => ({
  SPEECH_SAMPLE_RATE: 16000,
  startAsrStream: appMocks.startAsrStream,
}));

function seedStore() {
  useStore.setState({
    currentSessionPath: '/session/speech.jsonl',
    currentSessionId: 'sess_speech',
    currentAgentId: 'hana',
    sessions: [{ path: '/session/speech.jsonl', sessionId: 'sess_speech', agentId: 'hana', agentName: 'Hana' }],
    sessionLocatorsById: { sess_speech: { path: '/session/speech.jsonl' } },
    connected: true,
    pendingNewSession: false,
    streamingSessions: [],
    inlineErrors: {},
    attachedFiles: [],
    attachedFilesBySession: {},
    docContextAttached: false,
    quoteCandidate: null,
    quotedSelections: [],
    models: [{ id: 'deepseek-chat', provider: 'deepseek', name: 'DeepSeek Chat', input: ['text'], isCurrent: true }],
    sessionModelsByPath: {},
    previewItems: [],
    previewOpen: false,
    chatSessions: {},
    serverPort: 3210,
    serverToken: null,
    modelSwitching: false,
  } as never);
}

/** 麦克风与 AudioContext 的最小替身：只要能走完采集那段初始化就行 */
function installAudioMocks() {
  const processor = { onaudioprocess: null as unknown, connect: vi.fn(), disconnect: vi.fn() };
  class AudioContextMock {
    sampleRate = 16000;
    state = 'running';
    destination = {};
    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
    createScriptProcessor = vi.fn(() => processor);
    createGain = vi.fn(() => ({ gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() }));
    close = vi.fn(async () => {});
  }
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
  });
  vi.stubGlobal('AudioContext', AudioContextMock);
}

describe('语音输入：句末提交用的是引擎的处理后文本', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorMocks.inserted.length = 0;
    appMocks.handlers = null;
    seedStore();
    installAudioMocks();
    // 「语音输入」开关是开着的 → 按钮才出现
    appMocks.hanaFetch.mockImplementation(async () => new Response(
      JSON.stringify({ providers: {}, config: { enabled: false, inputEnabled: true } }),
      { status: 200 },
    ));
    appMocks.startAsrStream.mockImplementation(async (handlers: typeof appMocks.handlers) => {
      appMocks.handlers = handlers;
      return appMocks.session;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('endpoint 事件带来的带标点文本被写进文档，而不是预览层的原始文本', async () => {
    render(React.createElement(InputArea));

    const button = await screen.findByTestId('speech-input');
    fireEvent.click(button);

    // 等 startAsrStream 被调到（说明识别流已接上，handlers 已注册）
    await waitFor(() => expect(appMocks.handlers).not.toBeNull());

    // 预览层收到的是原始识别结果（没标点、数字还是汉字）
    appMocks.handlers!.onPartial?.('测试三百六十五天', false, 0);
    // 引擎句末定稿，给出处理后的版本
    appMocks.handlers!.onEndpoint?.('测试三百六十五天。', 0);

    await waitFor(() => expect(editorMocks.inserted.length).toBeGreaterThan(0));

    expect(editorMocks.inserted).toContain('测试三百六十五天。');
    expect(editorMocks.inserted).not.toContain('测试三百六十五天');
  });

  it('final 事件的 pending 段同样会被提交（用户按停止的那条路径）', async () => {
    render(React.createElement(InputArea));

    fireEvent.click(await screen.findByTestId('speech-input'));
    await waitFor(() => expect(appMocks.handlers).not.toBeNull());

    appMocks.handlers!.onPartial?.('没有标点的原始稿', false, 0);
    appMocks.handlers!.onFinal?.({ text: '', segments: [], pending: '没有标点的原始稿。' });

    await waitFor(() => expect(editorMocks.inserted.length).toBeGreaterThan(0));

    expect(editorMocks.inserted).toContain('没有标点的原始稿。');
  });
});
