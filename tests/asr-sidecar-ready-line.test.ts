/**
 * sidecar 就绪行的解析。
 *
 * 为什么单独测这个纯函数：它的两条输入通道（JSON / 中文日志）是**跨进程契约**，
 * 一侧改了文案或字段名，另一侧就会静默失效 —— 而失效的表现是「卡住等超时」，
 * 在集成测试里要靠拉起真进程 + 真模型才看得到（本地模型不全时那个测试还会被跳过）。
 * 所以把「该认哪一行」这件事单独钉住。
 */

import { describe, expect, it } from 'vitest';
import { parseSidecarReadyLine } from '../server/asr-sidecar-manager.ts';

describe('sidecar 就绪行解析', () => {
  it('优先认 JSON（机器可读的那条通道）', () => {
    expect(parseSidecarReadyLine('{"asrSidecarReady":true,"port":59187}')).toBe(59187);
  });

  it('JSON 里没有就绪标记、或端口不合法时，不认', () => {
    expect(parseSidecarReadyLine('{"asrSidecarReady":false,"port":1234}')).toBeNull();
    expect(parseSidecarReadyLine('{"asrSidecarReady":true}')).toBeNull();
    expect(parseSidecarReadyLine('{"other":1}')).toBeNull();
  });

  it('兜底：中文日志（老 sidecar，或 JSON 那行没打出来时）', () => {
    expect(
      parseSidecarReadyLine('[asr-sidecar] 模型加载完成（443ms），监听 ws://127.0.0.1:12345'),
    ).toBe(12345);
  });

  it('无关的行一律返回 null（不能把日志里的数字当端口）', () => {
    expect(parseSidecarReadyLine('[asr-sidecar] 后处理：数字规整=auto 标点=auto')).toBeNull();
    expect(parseSidecarReadyLine('')).toBeNull();
    expect(parseSidecarReadyLine('   ')).toBeNull();
    expect(parseSidecarReadyLine('{ 不是 JSON')).toBeNull();
  });
});
