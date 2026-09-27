// @vitest-environment jsdom
/**
 * W9227 · P1-5 聚焦测试：插件配置与开关**并发写**不得互相抹掉。
 *
 * 缺陷（审计 results/W9202-配置与提供商页.md P1-5）：服务端是**整表替换**
 * （PUT {disabled, config}），而客户端的每个 persist* 都是「读内存快照 → 算 next →
 * await 落库 → 写回镜像」。两个并发调用各自在 await **之前**读快照，于是后落库的那次
 * 会用旧快照覆盖前一次的改动 —— 「改一个插件的配置 + 切另一个插件的开关」时配置静默
 * 消失，界面上却显示成功。
 *
 * 修法：store.ts 内部加一条 promise 链（与后端 handlers/display-plugins.ts 的
 * SerialQueue 同构），把整个「读-改-写」放进临界区。
 *
 * 本文件用一个**有延迟**的 PUT 打桩制造窗口：延迟让两个请求真正重叠，否则本地
 * 微任务调度太快、窗口闭合，测试会给出假绿。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, resetHarness, reply } from './lib/w795-dom.js';

interface StoreMod {
  loadDisabledFromServer(knownIds: readonly string[]): Promise<string[]>;
  persistDisabledMany(changes: readonly { id: string; off: boolean }[], knownIds: readonly string[]): Promise<string[]>;
  persistPluginConfig(id: string, values: Record<string, string>, knownIds: readonly string[]): Promise<Record<string, string>>;
  savedConfigOf(id: string): Record<string, string>;
  disabledPlugins(): string[];
}

/** 已知 id：本测试不依赖真实登记表，store 层只认字符串。 */
const IDS = ['builtin.hljs', 'builtin.math', 'display.codeExtras', 'display.codeCopy'];

/** 服务端真值（整表替换语义：每次 PUT 都用它的 body 覆盖）。 */
const server = { disabled: [] as string[], config: {} as Record<string, Record<string, string>> };
/** 收到的 PUT body（按发起顺序），供机制性断言。 */
const bodies: Array<{ disabled: string[]; config: unknown }> = [];
/** PUT 延迟（ms）：制造并发窗口。 */
let putDelay = 0;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function stubServer(): void {
  vi.stubGlobal('fetch', async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    if (!u.startsWith('/api/display-plugins')) return reply(404, { ok: false });
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (method === 'PUT') {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { disabled?: unknown; config?: unknown };
      const disabled = Array.isArray(parsed.disabled) ? (parsed.disabled as string[]) : [];
      bodies.push({ disabled, config: parsed.config });
      // 收到即落库（= 服务端整表替换），随后才延迟返回 —— 窗口就在这段延迟里。
      server.disabled = disabled;
      if (parsed.config !== undefined) server.config = (parsed.config ?? {}) as Record<string, Record<string, string>>;
      await sleep(putDelay);
      return reply(200, { ok: true, disabled: server.disabled, config: server.config });
    }
    return reply(200, { ok: true, disabled: server.disabled, config: server.config });
  });
}

async function boot(): Promise<StoreMod> {
  const store = (await import(/* @vite-ignore */ at('plugins/store.ts'))) as StoreMod;
  await store.loadDisabledFromServer(IDS);
  return store;
}

beforeEach(() => {
  resetHarness();
  server.disabled = [];
  server.config = {};
  bodies.length = 0;
  putDelay = 30;
  stubServer();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('W9227 P1-5 · 并发写不互相抹掉', () => {
  it('改配置 + 切另一个插件的开关并发 ⇒ 两者都留在服务端', async () => {
    const store = await boot();
    // 同一个 tick 内发起两个写（真实的快速操作/键盘交互就是这个形状）。
    const a = store.persistPluginConfig('display.codeExtras', { foldLines: '40' }, IDS);
    const b = store.persistDisabledMany([{ id: 'builtin.hljs', off: true }], IDS);
    await Promise.all([a, b]);

    // 服务端最终状态：两个改动都在。
    expect(server.disabled).toEqual(['builtin.hljs']);
    expect(server.config).toEqual({ 'display.codeExtras': { foldLines: '40' } });
    // 客户端镜像同样一致。
    expect(store.disabledPlugins()).toEqual(['builtin.hljs']);
    expect(store.savedConfigOf('display.codeExtras')).toEqual({ foldLines: '40' });
  });

  it('机制：后发起的 PUT 必须已经带上前一次写回的内存镜像', async () => {
    const store = await boot();
    const a = store.persistPluginConfig('display.codeExtras', { foldLines: '40' }, IDS);
    const b = store.persistDisabledMany([{ id: 'builtin.hljs', off: true }], IDS);
    await Promise.all([a, b]);
    expect(bodies).toHaveLength(2);
    // 第一个 PUT 携带配置（开关尚未变）；第二个 PUT 必须同时带上配置与开关。
    expect(bodies[0]?.config).toEqual({ 'display.codeExtras': { foldLines: '40' } });
    expect(bodies[0]?.disabled).toEqual([]);
    expect(bodies[1]?.disabled).toEqual(['builtin.hljs']);
    expect(bodies[1]?.config, '第二个 PUT 不得用旧快照覆盖掉刚写的配置').toEqual({
      'display.codeExtras': { foldLines: '40' },
    });
  });

  it('两个不同插件的配置并发 ⇒ 两份都落库（后一个基于前一个的镜像）', async () => {
    const store = await boot();
    const a = store.persistPluginConfig('display.codeExtras', { foldLines: '40' }, IDS);
    const b = store.persistPluginConfig('display.codeCopy', { label: 'on' }, IDS);
    await Promise.all([a, b]);
    expect(server.config).toEqual({
      'display.codeExtras': { foldLines: '40' },
      'display.codeCopy': { label: 'on' },
    });
    expect(store.savedConfigOf('display.codeExtras')).toEqual({ foldLines: '40' });
    expect(store.savedConfigOf('display.codeCopy')).toEqual({ label: 'on' });
  });

  it('队列不会因一次失败卡死：失败后下一次写照常落库', async () => {
    const store = await boot();
    // 第一次：让服务端拒绝（打桩换成 500 一次）。
    const base = (globalThis as unknown as { fetch: (...a: unknown[]) => Promise<unknown> }).fetch;
    let failNext = true;
    vi.stubGlobal('fetch', async (url: unknown, init?: { method?: string; body?: unknown }) => {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (String(url).startsWith('/api/display-plugins') && method === 'PUT' && failNext) {
        failNext = false;
        return reply(500, { ok: false, error: 'nope' });
      }
      return base(url, init);
    });
    await expect(store.persistPluginConfig('display.codeExtras', { foldLines: '40' }, IDS)).rejects.toThrow();
    // 队列必须继续可用（旧实现若把 rejection 留在链上会永久卡住后续写）。
    await store.persistDisabledMany([{ id: 'builtin.hljs', off: true }], IDS);
    expect(server.disabled).toEqual(['builtin.hljs']);
  });
});
