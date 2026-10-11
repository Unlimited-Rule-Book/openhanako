// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputControlBar } from '../../components/input/InputControlBar';

vi.mock('../../components/input/PlanModeButton', () => ({
  PlanModeButton: () => React.createElement('button', { type: 'button' }, 'plan'),
}));

vi.mock('../../components/input/ContextRing', () => ({
  ContextRing: () => React.createElement('span', null, 'context'),
}));

vi.mock('../../components/input/ThinkingLevelButton', () => ({
  ThinkingLevelButton: () => React.createElement('button', { type: 'button' }, 'thinking'),
}));

vi.mock('../../components/input/ModelSelector', () => ({
  ModelSelector: () => React.createElement('button', { type: 'button' }, 'model'),
}));

vi.mock('../../components/input/SendButton', () => ({
  SendButton: () => React.createElement('button', { type: 'button' }, 'send'),
}));

function renderBar(overrides: Partial<React.ComponentProps<typeof InputControlBar>> = {}) {
  return render(<InputControlBar
    t={(key) => key}
    onAttach={vi.fn()}
    slashBtnRef={{ current: null }}
    onSlashToggle={vi.fn()}
    permissionMode="ask"
    onPermissionModeChange={vi.fn()}
    planModeLocked={false}
    showThinking={false}
    thinkingLevel="auto"
    onThinkingChange={vi.fn()}
    availableThinkingLevels={['off', 'medium', 'high']}
    models={[]}
    sessionModel={undefined}
    isStreaming={false}
    hasInput={false}
    canSend={false}
    showAudioInput={false}
    audioRecordingActive={false}
    audioRecordingBusy={false}
    onAudioToggle={vi.fn()}
    speechInputEnabled={false}
    speechInputActive={false}
    onSpeechInputToggle={vi.fn()}
    onSend={vi.fn()}
    onSteer={vi.fn()}
    onStop={vi.fn()}
    {...overrides}
  />);
}

describe('InputControlBar audio button', () => {
  afterEach(() => cleanup());

  it('hides the audio button when audio input is unsupported', () => {
    renderBar({ showAudioInput: false });

    expect(screen.queryByLabelText('input.recordAudio')).toBeNull();
  });

  it('shows the audio button and calls the toggle handler when audio input is supported', () => {
    const onAudioToggle = vi.fn();
    renderBar({ showAudioInput: true, onAudioToggle });

    const button = screen.getByLabelText('input.recordAudio');
    fireEvent.click(button);

    expect(onAudioToggle).toHaveBeenCalledTimes(1);
  });

  it('switches the audio button label while recording', () => {
    renderBar({ showAudioInput: true, audioRecordingActive: true });

    expect(screen.getByLabelText('input.stopRecording')).toBeTruthy();
  });
});

describe('InputControlBar speech input button', () => {
  afterEach(() => cleanup());

  it('hides the speech input button when speech recognition is disabled', () => {
    renderBar({ speechInputEnabled: false });

    expect(screen.queryByLabelText('input.startSpeechInput')).toBeNull();
  });

  it('shows the speech input button and calls the toggle handler', () => {
    const onSpeechInputToggle = vi.fn();
    renderBar({ speechInputEnabled: true, onSpeechInputToggle });

    const button = screen.getByLabelText('input.startSpeechInput');
    fireEvent.click(button);

    expect(onSpeechInputToggle).toHaveBeenCalledTimes(1);
  });

  it('switches the speech input label while listening', () => {
    renderBar({ speechInputEnabled: true, speechInputActive: true });

    expect(screen.getByLabelText('input.stopSpeechInput')).toBeTruthy();
  });

  // 两个按钮的门控条件互相独立：作者的录音按钮依赖对话模型是否原生音频，
  // 语音输入按钮只依赖语音识别是否启用，两者不共享状态。
  it('stays independent from the native-audio recording button', () => {
    renderBar({ speechInputEnabled: true, showAudioInput: false });

    expect(screen.getByLabelText('input.startSpeechInput')).toBeTruthy();
    expect(screen.queryByLabelText('input.recordAudio')).toBeNull();
  });

  it('connecting 阶段：界面上要**看得见**「正在加载模型…」（不能只有 tooltip）', () => {
    renderBar({ speechInputEnabled: true, speechInputActive: true, speechInputPhase: 'connecting' });

    // 可见文字（本文件的 t 是 (key) => key，所以断言的就是 key 本身）
    expect(screen.getByText('input.speechLoadingModel')).toBeTruthy();
    // 按钮还要带可见状态类：呼吸动画靠它，否则用户看到的是一个"没反应的按钮"
    const btn = screen.getByRole('button', { name: 'input.speechLoadingModel' });
    expect(btn.className).toContain('is-connecting');
    // 关键：此时**没有在录音**，不能套用"聆听中"的绿色样式，否则会误以为已经录上了
    expect(btn.className).not.toContain('is-listening');
  });

  it('transcribing 阶段：可见文字是「正在转写…」（采集已停、引擎在出结果）', () => {
    renderBar({ speechInputEnabled: true, speechInputActive: true, speechInputPhase: 'transcribing' });

    expect(screen.getByText('input.speechTranscribing')).toBeTruthy();
    const btn = screen.getByRole('button', { name: 'input.speechTranscribing' });
    expect(btn.className).toContain('is-connecting'); // 与 connecting 共用中性色样式
    expect(btn.className).not.toContain('is-listening');
  });

  it('listening 阶段：不挂这类状态文字（绿色脉冲已经够明显，再加字是噪声）', () => {
    renderBar({ speechInputEnabled: true, speechInputActive: true, speechInputPhase: 'listening' });

    expect(screen.queryByText('input.speechLoadingModel')).toBeNull();
    expect(screen.queryByText('input.speechTranscribing')).toBeNull();
    const btn = screen.getByRole('button', { name: 'input.stopSpeechInput' });
    expect(btn.className).toContain('is-listening');
  });
});
