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
});
