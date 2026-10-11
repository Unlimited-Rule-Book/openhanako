/**
 * @vitest-environment jsdom
 *
 * 「语音条转录模型」下拉里那个横杠（空选项）到底能不能选？
 *
 * 为什么要单独写这个测试：`MediaTab.test.tsx` 把 `@/ui` 整个 mock 成了原生 <select>，
 * 于是**测不到真实下拉的行为**（选中态、禁用态、点击后回调）。
 * 这个文件**不 mock `@/ui`**，用真实的 SelectWidget / Toggle 来实测。
 *
 * 结论先行（测试即证据）：
 *   · 打开开关时，横杠选项**是可选的**（没有 disabled 标记），点了会清空模型
 *   · 关闭开关时，整行控件 disabled → 表现成"灰色、点不开"，这才是"选不了"的来源
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => mocks.hanaFetch(...args),
}));

// t 返回 key 本身 → textOrFallback 会回退到内置中文，label 可预测为 i18n key
vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
}));

vi.mock('../../settings/components/SettingsSection', () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

// 只把行容器换成可查询的壳，**保留真实的 control**（真实 SelectWidget 就在里面）
vi.mock('../../settings/components/SettingsRow', () => ({
  SettingsRow: ({ label, control }: { label: string; control: React.ReactNode }) => (
    <div data-testid={`row:${label}`}>
      <span>{label}</span>
      {control}
    </div>
  ),
}));

vi.mock('../../settings/tabs/media/MediaProviderDetail', () => ({
  MediaProviderDetail: () => null,
}));

import { MediaTab } from '../../settings/tabs/MediaTab';
import { useSettingsStore } from '../../settings/store';

// 注意：textOrFallback 在 t 返回 key 时会回退到内置中文，所以标签是中文而不是 i18n key
const SPEECH_MODEL_ROW = 'row:语音条转录模型';

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as Response;
}

function seedProviders({ enabled, withModel }: { enabled: boolean; withModel: boolean }) {
  mocks.hanaFetch.mockImplementation((path: string) => {
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
        config: {
          enabled,
          inputEnabled: true,
          ...(withModel ? { defaultModel: { provider: 'openai', id: 'whisper-1' } } : {}),
        },
      }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

/** 打开指定行里的下拉面板 */
function openDropdown(rowTestId: string) {
  const row = screen.getByTestId(rowTestId);
  const trigger = row.querySelector('button') as HTMLButtonElement;
  fireEvent.click(trigger);
  return trigger;
}

describe('语音条转录模型：空选项（横杠）的可选性', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // MediaTab 会读 settingsSnapshot.data（用于同步设置快照），没种子会直接抛
    useSettingsStore.setState({
      settingsSnapshot: {
        key: null,
        status: 'idle',
        data: null,
        error: null,
        requestId: 0,
        updatedAt: null,
      },
    } as never);
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ settingsSnapshot: undefined as never });
  });

  it('开关打开时：横杠选项**可点**，点击会清空模型', async () => {
    seedProviders({ enabled: true, withModel: true });
    render(<MediaTab />);

    // 等配置加载完（触发器的文字变成模型名）
    await waitFor(() => {
      expect(screen.getByTestId(SPEECH_MODEL_ROW).textContent).toContain('openai / Whisper 1');
    });

    openDropdown(SPEECH_MODEL_ROW);

    const dash = await screen.findByRole('option', { name: '—' });
    // 关键断言：没有 disabled —— 也就是说它是**可以选的**
    expect(dash).not.toBeDisabled();

    fireEvent.click(dash);

    await waitFor(() => {
      const saveCall = mocks.hanaFetch.mock.calls.find(([path]) => path === '/api/speech-recognition/config');
      expect(saveCall).toBeTruthy();
      expect(JSON.parse(String((saveCall?.[1] as RequestInit).body))).toEqual({ values: { defaultModel: null } });
    });
  });

  it('开关关闭时：整行控件被禁用（这才是"灰色、点不了"的来源）', async () => {
    seedProviders({ enabled: false, withModel: true });
    render(<MediaTab />);

    await waitFor(() => {
      expect(screen.getByTestId(SPEECH_MODEL_ROW)).toBeTruthy();
    });

    const trigger = screen.getByTestId(SPEECH_MODEL_ROW).querySelector('button') as HTMLButtonElement;
    // 关掉开关 → 控件 disabled → 面板点不开、文字变灰
    expect(trigger).toBeDisabled();
  });

  it('开关打开但没配模型时：横杠在触发器中以正常颜色显示（isPlaceholder 为 false）', async () => {
    seedProviders({ enabled: true, withModel: false });
    render(<MediaTab />);

    await waitFor(() => {
      const row = screen.getByTestId(SPEECH_MODEL_ROW);
      // value 落在选项里 → 不算 placeholder → 用正常字色（用户看到的"黑色横杠"）
      expect(row.textContent).toContain('—');
    });

    const trigger = screen.getByTestId(SPEECH_MODEL_ROW).querySelector('button') as HTMLButtonElement;
    expect(trigger).not.toBeDisabled();
  });
});
