import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * sidecar 生命周期的**单元测试**（打桩，不真的拉起子进程）。
 *
 * 专门覆盖"换模型时旧进程的 exit 事件晚到"这个竞态：集成测试
 * （asr-sidecar-manager.test.ts）真起进程、又受本地模型是否装全的限制，
 * 很难稳定复现这种时序，所以这里用假的 child_process 精确控制事件顺序。
 *
 * 对照的 bug：旧进程的 exit 处理**无条件**把 child/port/pending 置空，
 * 若此时新进程已经起来了，就会把新进程的记录覆盖掉 —— stop() 关不掉它，变孤儿。
 */

// vi.mock 会被提升到 import 之上，取出被 fake 的 spawn 产出的进程只能靠 vi.hoisted。
const state = vi.hoisted(() => ({ children: [] as any[] }));

vi.mock('node:fs', () => ({
  default: { existsSync: () => true },
  existsSync: () => true,
}));

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeChild extends EventEmitter {
    killed = false;
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    // 真实的 kill 是异步的：这里只打标记、不立刻发 exit，
    // 好让测试自己决定"旧进程的 exit 什么时候才到"。
    kill() {
      this.killed = true;
      return true;
    }
  }
  return {
    spawn: () => {
      const child = new FakeChild();
      state.children.push(child);
      return child;
    },
  };
});

import { createAsrSidecarManager } from '../server/asr-sidecar-manager.ts';

const readyLine = (port: number) =>
  `[asr-sidecar] 模型加载完成（1ms），监听 ws://127.0.0.1:${port}`;

describe('asr-sidecar-manager 生命周期（打桩）', () => {
  beforeEach(() => {
    state.children.length = 0;
  });

  it('换模型后旧进程的 exit 迟到，不会抹掉新进程的跟踪，stop() 仍能关掉它', async () => {
    const manager = createAsrSidecarManager({ rootDir: '/repo' });

    // 第一次：拉起 modelA 并让它就绪
    const first = manager.ensureStarted('modelA');
    state.children[0].stdout.emit('data', readyLine(1111));
    const s1 = await first;
    expect(s1.ready).toBe(true);
    expect(s1.port).toBe(1111);

    // 换到 modelB：stop() 收掉 A（kill），随即起 B
    const second = manager.ensureStarted('modelB');
    expect(state.children).toHaveLength(2);
    expect(state.children[0].killed).toBe(true);
    state.children[1].stdout.emit('data', readyLine(2222));
    const s2 = await second;
    expect(s2.port).toBe(2222);

    // 关键时刻：旧进程 A 的 exit 现在才到。
    // 修复前这里会把 child/port/pending 全清空，把 B 的记录一起抹掉。
    state.children[0].emit('exit', 0, 'SIGTERM');

    expect(manager.status().ready).toBe(true);
    expect(manager.status().port).toBe(2222);

    // stop() 仍指向 B，并且真的能关掉 B
    manager.stop();
    expect(state.children[1].killed).toBe(true);
    expect(manager.status().ready).toBe(false);
    expect(manager.status().port).toBeNull();
  });

  it('启动过程中 stop()：启动 Promise 立刻收尾（不挂满 30 秒），之后还能正常重启', async () => {
    // 时间调成假的：如果这次收尾真的依赖了那个 30 秒兜底计时器，
    // 这个用例就会直接超时失败 —— 正是我们要防的回归。
    vi.useFakeTimers();
    try {
      const manager = createAsrSidecarManager({ rootDir: '/repo' });

      const starting = manager.ensureStarted('modelA');
      expect(state.children).toHaveLength(1);
      // 故意不发就绪行：模拟"还在加载模型"的那几秒

      manager.stop();
      expect(state.children[0].killed).toBe(true);

      // 修复前：stop() 已把 child 置空 → 旧进程的 exit 命中"不是当前 child 就 return"，
      // 那次启动的 Promise 没人收，只能干等 30 秒超时。
      state.children[0].emit('exit', 0, 'SIGTERM');
      await expect(starting).resolves.toMatchObject({ ready: false });
      expect(vi.getTimerCount()).toBe(0); // 兜底计时器已被清掉，没有残留

      // 停掉之后还能正常重启：挂起记录没有被"那次已作废的启动"挡住
      const restarted = manager.ensureStarted('modelB');
      expect(state.children).toHaveLength(2);
      state.children[1].stdout.emit('data', readyLine(3333));
      await expect(restarted).resolves.toMatchObject({ ready: true, port: 3333 });
    } finally {
      vi.useRealTimers();
    }
  });
});
