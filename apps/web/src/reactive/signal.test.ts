import { describe, it, expect, vi } from 'vitest';

import { signal, computed, effect, batch, untrack, onCleanup } from './signal';

describe('signal', () => {
  it('读回写入的值', () => {
    const s = signal(1);
    expect(s.get()).toBe(1);
    s.set(2);
    expect(s.get()).toBe(2);
  });

  it('effect 立即执行一次以收集依赖，此后仅在依赖变化时重跑', () => {
    const s = signal(1);
    const spy = vi.fn();
    effect(() => {
      spy();
      s.get();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    s.set(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('等值写入（Object.is）不触发 effect', () => {
    const s = signal(1);
    const spy = vi.fn();
    effect(() => {
      spy();
      s.get();
    });
    s.set(1);
    s.set(1);
    expect(spy).toHaveBeenCalledTimes(1);
    s.set(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('只重跑依赖了变化信号的那些 effect', () => {
    const a = signal(1);
    const b = signal(1);
    const spyA = vi.fn();
    effect(() => {
      spyA();
      a.get();
    });
    b.set(99);
    expect(spyA).toHaveBeenCalledTimes(1);
    a.set(2);
    expect(spyA).toHaveBeenCalledTimes(2);
  });

  it('注销后不再被触发', () => {
    const s = signal(0);
    const spy = vi.fn();
    const dispose = effect(() => {
      spy();
      s.get();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    dispose();
    s.set(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('重复注销是幂等的', () => {
    const s = signal(0);
    const spy = vi.fn();
    const dispose = effect(() => {
      spy();
      s.get();
    });
    dispose();
    dispose();
    s.set(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('依赖会被重新收集：条件分支切换后不再响应旧依赖', () => {
    const useA = signal(true);
    const a = signal('a');
    const b = signal('b');
    const seen: string[] = [];
    effect(() => {
      seen.push(useA.get() ? a.get() : b.get());
    });
    expect(seen).toEqual(['a']);
    useA.set(false);
    expect(seen).toEqual(['a', 'b']);
    a.set('a2');
    expect(seen).toEqual(['a', 'b']);
    b.set('b2');
    expect(seen).toEqual(['a', 'b', 'b2']);
  });

  it('computed 派生值并向下游传播', () => {
    const n = signal(2);
    const doubled = computed(() => n.get() * 2);
    const spy = vi.fn();
    effect(() => {
      spy();
      doubled.get();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(doubled.get()).toBe(4);
    n.set(5);
    expect(doubled.get()).toBe(10);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('batch 把多次写入合并为一次重跑', () => {
    const a = signal(1);
    const b = signal(2);
    const spy = vi.fn();
    effect(() => {
      spy();
      a.get();
      b.get();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    batch(() => {
      a.set(10);
      b.set(20);
      a.set(100);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(a.get()).toBe(100);
    expect(b.get()).toBe(20);
  });

  it('batch 结束后 effect 看到的是最终值', () => {
    const a = signal(0);
    const seen: number[] = [];
    effect(() => {
      seen.push(a.get());
    });
    batch(() => {
      a.set(1);
      a.set(2);
      a.set(3);
    });
    expect(seen).toEqual([0, 3]);
  });

  it('自触发保护：effect 不因写回自己依赖的信号而无限递归', () => {
    const s = signal(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let runs = 0;
    effect(() => {
      runs++;
      const v = s.get();
      if (v === 0) s.set(1);
    });
    expect(runs).toBe(1);
    expect(s.get()).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('readonly 视图可读，且读操作同样参与依赖追踪', () => {
    const s = signal(1);
    const ro = s.readonly();
    const spy = vi.fn();
    effect(() => {
      spy();
      ro.get();
    });
    expect(ro.get()).toBe(1);
    s.set(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('signal · 健壮性（四道闸）', () => {
  it('peek 读值但不建立依赖', () => {
    const watched = signal(1);
    const peeked = signal(1);
    const spy = vi.fn();
    effect(() => {
      spy();
      watched.get();
      peeked.peek();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    peeked.set(2); // 只 peek 过 → 不该唤醒
    expect(spy).toHaveBeenCalledTimes(1);
    watched.set(2); // 真正依赖的才唤醒
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('untrack 内的读不入依赖', () => {
    const s = signal(1);
    const spy = vi.fn();
    effect(() => {
      spy();
      untrack(() => s.get());
    });
    s.set(2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('onCleanup 在重跑前执行（先清旧的，再建新的）', () => {
    const s = signal(0);
    const log: string[] = [];
    effect(() => {
      const v = s.get();
      log.push('run:' + v);
      onCleanup(() => log.push('clean:' + v));
    });
    expect(log).toEqual(['run:0']);
    s.set(1);
    expect(log).toEqual(['run:0', 'clean:0', 'run:1']);
  });

  it('onCleanup 在注销时执行，且之后不再跑', () => {
    const s = signal(0);
    const log: string[] = [];
    const dispose = effect(() => {
      s.get();
      onCleanup(() => log.push('clean'));
    });
    dispose();
    expect(log).toEqual(['clean']);
    s.set(1);
    expect(log).toEqual(['clean']);
  });

  it('onCleanup 在 effect 外调用只 warn，不登记', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onCleanup(() => {});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('抛错隔离：一个 effect 抛错不打断同批其它 effect，也不抛回 set()', () => {
    const s = signal(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const good = vi.fn();
    effect(() => {
      s.get();
      throw new Error('boom');
    });
    effect(() => {
      good();
      s.get();
    });
    expect(good).toHaveBeenCalledTimes(1);
    expect(() => s.set(1)).not.toThrow();
    expect(good).toHaveBeenCalledTimes(2); // 坏 effect 没有拖垮它
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('清理函数抛错被隔离，不影响后续清理与重跑', () => {
    const s = signal(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log: string[] = [];
    effect(() => {
      s.get();
      onCleanup(() => {
        throw new Error('cleanup boom');
      });
      onCleanup(() => log.push('second cleanup'));
      log.push('run');
    });
    expect(() => s.set(1)).not.toThrow();
    expect(log).toEqual(['run', 'second cleanup', 'run']); // 第二个清理仍然跑了
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('effect 互相触发（成环）不会栈溢出', () => {
    const a = signal(0);
    const b = signal(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    effect(() => {
      const v = a.get();
      if (v > 0) b.set(v + 1);
    });
    effect(() => {
      const v = b.get();
      if (v > 0) a.set(v + 1);
    });
    expect(() => a.set(1)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('batch 内抛错仍会消费已入队的 effect', () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy();
      s.get();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    batch(() => {
      s.set(5);
      throw new Error('boom');
    });
    expect(spy).toHaveBeenCalledTimes(2); // 队列被消费，effect 跑了
    expect(s.get()).toBe(5);
    warn.mockRestore();
  });
});
