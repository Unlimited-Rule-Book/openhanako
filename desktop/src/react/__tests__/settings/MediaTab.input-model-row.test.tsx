/**
 * @vitest-environment jsdom
 *
 * 「识别引擎」（模型）这一行的设计契约。
 *
 * 用户明确提的设计意图：**模型选择不是「云端批式」的专利** ——
 * 三种识别方式（本地 / 云端流式 / 云端批式）在模型选择上是**平权的**，
 * 差别只在"这个方式提供了哪几个候选模型"，不在"谁有资格选"。
 *
 * 所以实现上必须是**同一套接口**（同一个 SelectWidget + 各自一份候选列表），
 * 能不能点开只由候选数量决定（`inputModelLocked = options.length <= 1`），
 * 而不是写死"云端流式就不能选"。
 *
 * 这个测试锁的就是这条契约：将来给本地或云端流式加模型，不该改这里的逻辑，
 * 只该改候选列表。
 *
 * 注意：本文件**不 mock `@/ui`**，用真实的 SelectWidget 渲染。
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => mocks.hanaFetch(...args),
}));

// t 返回 key 本身 → textOrFallback 回退到内置中文，标签可预测
vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
}));

vi.mock('../../settings/components/SettingsSection', () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

vi.mock('../../settings/components/SettingsRow', () => ({
  SettingsRow: ({ label, hint, control }: { label: string; hint?: string; control: React.ReactNode }) => (
    <div data-testid={`row:${label}`}>
      <span>{label}</span>
      {hint ? <span>{hint}</span> : null}
      {control}
    </div>
  ),
}));

vi.mock('../../settings/tabs/media/MediaProviderDetail', () => ({
  MediaProviderDetail: () => null,
}));

import { MediaTab } from '../../settings/tabs/MediaTab';
import { useSettingsStore } from '../../settings/store';

const METHOD_ROW = 'row:识别方式';
const MODEL_ROW = 'row:识别引擎';

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as Response;
}

function seed(
  inputEngine: string,
  { streamingCredentials = true, modelStatus, download }: {
    streamingCredentials?: boolean;
    modelStatus?: any[];
    download?: any;
  } = {},
) {
  mocks.hanaFetch.mockImplementation((path: string) => {
    if (path === '/api/asr/models') {
      return Promise.resolve(jsonResponse({
        modelsRoot: '/tmp/models',
        sources: [],
        models: modelStatus || [],
        download: download
          || { ids: [], received: 0, total: 0, sourceId: null, currentFile: null, error: null, cancelled: false },
      }));
    }
    if (path === '/api/media/image/providers') return Promise.resolve(jsonResponse({ providers: {}, config: {} }));
    if (path === '/api/media/video/providers') return Promise.resolve(jsonResponse({ providers: {}, config: {} }));
    if (path === '/api/speech-recognition/providers') {
      return Promise.resolve(jsonResponse({
        providers: {
          openai: {
            providerId: 'openai',
            displayName: 'OpenAI Speech',
            hasCredentials: true,
            models: [{ id: 'whisper-1', name: 'Whisper 1', adapterAvailable: true }],
          },
        },
        // 云端流式的候选来自服务端这段（speechRecognitionStreaming 能力）
        streamingProviders: {
          dashscope: {
            providerId: 'dashscope',
            displayName: 'DashScope',
            hasCredentials: streamingCredentials,
            models: [
              { id: 'paraformer-realtime-v2', name: 'Paraformer Realtime v2', adapterAvailable: true },
              { id: 'fun-asr-realtime', name: 'Fun-ASR Realtime', adapterAvailable: true },
            ],
          },
        },
        config: { enabled: true, inputEnabled: true, inputEngine },
      }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

function modelRowButton() {
  return screen.getByTestId(MODEL_ROW).querySelector('button') as HTMLButtonElement;
}

async function waitModelRowReady() {
  await waitFor(() => {
    expect(modelRowButton()).toBeTruthy();
    expect(modelRowButton().textContent).not.toBe('__loading');
  });
}

describe('识别引擎（模型）行：三种识别方式平权', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      settingsSnapshot: { key: null, status: 'idle', data: null, error: null, requestId: 0, updatedAt: null },
    } as never);
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ settingsSnapshot: undefined as never });
  });

  it('本地：模型行可选，候选是那两个本地模型', async () => {
    seed('local');
    render(<MediaTab />);
    await waitModelRowReady();

    const trigger = modelRowButton();
    expect(trigger).not.toBeDisabled();
    expect(trigger.textContent).toContain('中文 14M');

    fireEvent.click(trigger);
    const options = await screen.findAllByRole('option');
    const labels = options.map(o => o.textContent);
    expect(labels).toContain('中文 14M（默认，最快）');
    expect(labels).toContain('中英双语');
  });

  it('云端流式：候选是服务端给的实时模型列表（不再是写死的一个）', async () => {
    seed('cloud');
    render(<MediaTab />);
    await waitModelRowReady();

    const trigger = modelRowButton();
    expect(trigger).not.toBeDisabled();
    // 没选过模型时显示空选项；能点开看到全部候选
    fireEvent.click(trigger);
    const options = await screen.findAllByRole('option');
    const labels = options.map(o => o.textContent);
    expect(labels).toContain('—');
    expect(labels).toContain('dashscope / Paraformer Realtime v2');
    expect(labels).toContain('dashscope / Fun-ASR Realtime');
  });

  it('云端流式：供应商没有凭据时，模型置灰而不是消失（对齐「默认图片模型」的做法）', async () => {
    seed('cloud', { streamingCredentials: false });
    render(<MediaTab />);
    await waitModelRowReady();

    fireEvent.click(modelRowButton());
    const options = await screen.findAllByRole('option');
    const paraformer = options.find(o => o.textContent?.includes('Paraformer Realtime v2'));
    expect(paraformer).toBeTruthy();
    expect(paraformer).toBeDisabled();
    expect(paraformer?.textContent).toContain('未配置凭据');
  });

  it('云端批式：同样是可选的下拉，候选来自云端模型列表', async () => {
    seed('cloud-batch');
    render(<MediaTab />);
    await waitModelRowReady();

    const trigger = modelRowButton();
    expect(trigger).not.toBeDisabled();

    fireEvent.click(trigger);
    const options = await screen.findAllByRole('option');
    // 空选项（横杠）+ 作者那套可运行模型
    expect(options.map(o => o.textContent)).toContain('openai / Whisper 1');
  });

  it('三种方式用的是**同一个控件形态**（都渲染出下拉三角，只是禁用与否不同）', async () => {
    for (const engine of ['local', 'cloud', 'cloud-batch']) {
      cleanup();
      seed(engine);
      render(<MediaTab />);
      await waitModelRowReady();

      const row = screen.getByTestId(MODEL_ROW);
      // 同一套接口：都只有一个 SelectWidget 触发器
      expect(within(row).getAllByRole('button')).toHaveLength(1);
      expect(row.querySelector('svg')).toBeTruthy();   // 右侧小三角
    }
  });

  it('只缺标点模型时：仍要给下载/导入入口（识别模型已装好也不能把入口收起来）', async () => {
    // 用户实测到的场景：中文模型补好了，但标点还只是个半包（model.onnx 缺）
    seed('local', {
      modelStatus: [
        { id: 'zh-14M', state: 'ready', missingBytes: 0, missing: [], totalBytes: 25 },
        { id: 'punct', state: 'missing', missingBytes: 295000000, missing: ['model.onnx'], totalBytes: 295000000 },
      ],
    });
    render(<MediaTab />);
    await waitModelRowReady();

    // 提示行要在（本文件的 t 被 mock 成返回 key 本身，所以按 key 断言）
    expect(await screen.findByTestId('row:settings.media.localModelConfirm')).toBeInTheDocument();

    // 点「我已有模型文件」→ 导入面板必须能打开：
    // 判据若只看"所选识别模型是否就绪"，这里就会被错误地收起来（用户实测到了）
    fireEvent.click(await screen.findByText('settings.media.localModelManual'));
    expect(await screen.findByTestId('row:settings.media.localModelDropTitle')).toBeInTheDocument();
    // 缺失清单要按模型分组，明确指出是标点模型缺 model.onnx
    expect(screen.getByText(/settings.media.localModelPunctLabel/)).toBeInTheDocument();
    expect(screen.getByText(/model.onnx/)).toBeInTheDocument();
  });

  it('别的模型下载失败 → 切到中文后，那条"下载失败"不能跟过来（用户实测到的 bug）', async () => {
    // 中文与标点都装好了；那次被取消的下载是**中英双语**发起的
    seed('local', {
      modelStatus: [
        { id: 'zh-14M', state: 'ready', missingBytes: 0, missing: [], totalBytes: 25 },
        { id: 'punct', state: 'ready', missingBytes: 0, missing: [], totalBytes: 295 },
      ],
      download: {
        ids: ['bilingual', 'punct'], received: 0, total: 100, sourceId: 'hf-mirror',
        currentFile: null, error: null, cancelled: true,
      },
    });
    render(<MediaTab />);
    await waitModelRowReady();

    // 这一行不该出现任何下载/失败提示 —— 那次失败不是"中文"的事
    expect(screen.queryByTestId('row:settings.media.localModelFailed')).toBeNull();
    expect(screen.queryByTestId('row:settings.media.localModelConfirm')).toBeNull();
  });

  it('失败提示只在"还有东西要补"时显示：自己这个模型失败且仍缺文件 → 必须显示（过滤不能过头）', async () => {
    seed('local', {
      modelStatus: [
        { id: 'zh-14M', state: 'partial', missingBytes: 48697, missing: ['tokens.txt'], totalBytes: 25 },
        { id: 'punct', state: 'ready', missingBytes: 0, missing: [], totalBytes: 295 },
      ],
      download: {
        ids: ['zh-14M', 'punct'], received: 0, total: 100, sourceId: 'hf-mirror',
        currentFile: null, error: '下载失败：tokens.txt（已试过 2 个源）', cancelled: false,
      },
    });
    render(<MediaTab />);
    await waitModelRowReady();

    expect(await screen.findByTestId('row:settings.media.localModelFailed')).toBeInTheDocument();
    // 三个出口都要在
    expect(screen.getByText('settings.media.localModelRetry')).toBeInTheDocument();
    expect(screen.getByText('settings.media.localModelSwitchSource')).toBeInTheDocument();
    expect(screen.getByText('settings.media.localModelManual')).toBeInTheDocument();
  });

  it('模型已经补齐后，那条"下载已取消"必须消失（用户实测：自己导入成功后它还赖着）', async () => {
    // 现场：下载标点到一半取消，随后用户自己把完整模型导入了 → 模型已齐
    seed('local', {
      modelStatus: [
        { id: 'zh-14M', state: 'ready', missingBytes: 0, missing: [], totalBytes: 25 },
        { id: 'punct', state: 'ready', missingBytes: 0, missing: [], totalBytes: 295 },
      ],
      download: {
        ids: ['zh-14M', 'punct'], received: 0, total: 100, sourceId: 'hf-mirror',
        currentFile: null, error: null, cancelled: true,
      },
    });
    render(<MediaTab />);
    await waitModelRowReady();

    // 事实层面那次下载确实取消了，但已经没有可操作性 —— 不该继续占着界面
    expect(screen.queryByTestId('row:settings.media.localModelFailed')).toBeNull();
    expect(screen.queryByTestId('row:settings.media.localModelConfirm')).toBeNull();
  });
});
