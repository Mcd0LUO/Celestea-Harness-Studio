// @vitest-environment jsdom
/**
 * W9327 — 设置页「插件」面板**如实呈现后端给的东西**（前端不再说反话）。
 *
 * W9322 之后端已上线两层清单（8 host + 6 engine），每行带 `layer` / `hot` /
 * `enabled` / `disable`(`optional`|`idle-only`|`required`) / `reason`，并新增
 * `PUT /api/plugins`。而前端此前**一个字没改**，且在说反话：徽标**硬编码**
 * 「进程内不可热拔插」，而那 6 行引擎插件恰恰 `hot: true`（可换代）；`disable`
 * 在整个 `ui/plugins` 里 0 命中；服务端一段**只读**，没有任何开关。
 *
 * 四条不变量（本文件逐条钉住，外加两条变异负控制）：
 *   ① 徽标**随 `hot` 变化**（不硬编码）——`hot:true` ≠ `hot:false` 的徽标；
 *   ② `required` 行**没有开关**，且**显示**后端给的 `reason`（拒绝必须说出来）；
 *   ③ `optional` / `idle-only` 行**有开关**，拨动接 `PUT /api/plugins`；
 *   ④ 未知 `disable` 取值**如实降级**：不画开关、不假装认识（标出原值）。
 *   ⑤ 按 `layer` 分两段（host / engine），顺序按服务端给的 mount 顺序。
 *
 * 说明：本文件自己补设置页宿主（resetHarness 之后插真实 index.html 的 #app 壳），
 * 不改 tests/lib/w795-dom.ts（与 w11-client-plugins.test.ts 同一做法）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, WEB, type ElLike } from './lib/w795-dom.js';

interface InputLike extends ElLike {
  checked: boolean;
}
interface BodyLike extends ElLike {
  insertAdjacentHTML(pos: string, html: string): void;
}
interface CfgMod {
  initSettingsPage(): void;
}
interface HintMod {
  initHints(): void;
}

const q = (sel: string): ElLike | null => doc.querySelector(sel);
const qa = (sel: string): ElLike[] => Array.from(doc.querySelectorAll(sel));

/** 服务端两层的真值行（与 apps/studio/src/plugin-catalog.ts 同形，只取渲染用到的字段）。 */
const ROWS = [
  // host 层：5 required（不可关）+ 2 idle-only（无会话时可关）
  { name: 'studio/workspaces', layer: 'host', hot: true, enabled: true, disable: 'required', reason: 'sessions mounts on ctx.require(WORKSPACES_SERVICE)' },
  { name: 'studio/sessions', layer: 'host', hot: true, enabled: true, disable: 'required', reason: 'every /api/sessions route resolves through it' },
  { name: 'studio/bus', layer: 'host', hot: true, enabled: true, disable: 'idle-only', reason: 'studio/bus is the connection point of every SSE stream' },
  { name: 'studio/runtime', layer: 'host', hot: true, enabled: true, disable: 'idle-only', reason: 'the engine seam every live session was composed against' },
  // engine 层：2 required + 4 optional（可关），全部 hot:true
  { name: 'studio.engine.llm', layer: 'engine', hot: true, enabled: true, disable: 'required', reason: "compose() resolves LLM_SERVICE as a seam" },
  { name: 'studio.engine.agent-loop', layer: 'engine', hot: true, enabled: true, disable: 'required', reason: "compose() throws ComposeError('no AgentLoop')" },
  { name: 'studio.engine.tools', layer: 'engine', hot: true, enabled: true, disable: 'optional' },
  { name: 'celestea.runtime.workers', layer: 'engine', hot: true, enabled: true, disable: 'optional' },
  // 一行 hot:false —— 徽标必须与上面那些 hot:true 的**不同**
  { name: 'frozen.thing', layer: 'engine', hot: false, enabled: true, disable: 'optional' },
  // 未知 disable 取值（将来契约扩枚举）：如实降级，不假装认识
  { name: 'weird.plugin', layer: 'engine', hot: true, enabled: true, disable: 'quantum-only', reason: 'no documented semantics yet' },
] as const;

/** 打桩的 GET/PUT /api/plugins（真实模块走真实 fetch 路径）。 */
const server = {
  rows: [] as Record<string, unknown>[],
  puts: [] as unknown[][],
  failPut: false,
};

function stubPlugins(): void {
  const base = (globalThis as unknown as { fetch: (u: unknown, i?: unknown) => Promise<unknown> }).fetch;
  vi.stubGlobal('fetch', (url: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    if (!u.startsWith('/api/plugins')) return base(url, init);
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (method === 'PUT') {
      if (server.failPut) return Promise.resolve(reply(500, { ok: false, error: 'cannot persist plugins' }));
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { enabled?: unknown };
      server.puts.push(Array.isArray(parsed.enabled) ? (parsed.enabled as unknown[]) : []);
      // 真值：enabled 表的补集 = disabled 行（与后端同一语义）。
      const on = new Set(server.rows.filter((r) => Array.isArray(parsed.enabled) && (parsed.enabled as unknown[]).includes(r['name'])).map((r) => r['name']));
      const next = server.rows.map((r) => ({ ...r, enabled: on.has(r['name']) }));
      server.rows = next;
      return Promise.resolve(reply(200, { ok: true, plugins: next }));
    }
    return Promise.resolve(reply(200, { ok: true, plugins: server.rows }));
  });
}

function appMarkup(): string {
  const raw = readFileSync(join(WEB, 'index.html'), 'utf8');
  return raw.slice(raw.indexOf('<div id="app">'), raw.indexOf('<script type="module"'));
}

/** 走真实装配路径打开「插件」一格（initHints → initSettingsPage → 点导航 → 等清单）。 */
async function openPlugins(): Promise<void> {
  const hints = (await import(/* @vite-ignore */ at('ui/hint/index.ts'))) as HintMod;
  hints.initHints();
  const cfg = (await import(/* @vite-ignore */ at('ui/config.ts'))) as CfgMod;
  cfg.initSettingsPage();
  q('.settings-nav-item[data-page="plugins"]')?.dispatchEvent(new Ev('click'));
  await flush();
}

const rowOf = (name: string): ElLike => q('#settingsPlugins .plug-host[data-name="' + name + '"]') as ElLike;
const badgeOf = (name: string): string => rowOf(name).querySelector('.plug-badge')?.textContent ?? '';
const switchOf = (name: string): InputLike | null =>
  rowOf(name).querySelector('.plug-switch-input') as InputLike | null;

beforeEach(() => {
  resetHarness();
  server.rows = ROWS.map((r) => ({ ...r }));
  server.puts = [];
  server.failPut = false;
  stubPlugins();
  (doc.body as BodyLike).insertAdjacentHTML('beforeend', appMarkup());
});
afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

describe('W9327 服务端插件行 · 如实呈现', () => {
  it('① 徽标随 hot 变化（不硬编码）：hot:true 与 hot:false 两行文案不同', async () => {
    await openPlugins();
    const hotTrue = badgeOf('studio.engine.tools');
    const hotFalse = badgeOf('frozen.thing');
    expect(hotTrue).not.toBe('');
    expect(hotFalse).not.toBe('');
    // 这正是前端此前说反话的地方：6 行引擎插件 hot:true（可换代），
    // 旧实现却对它们一律标「进程内不可热拔插」。
    expect(hotTrue).not.toBe(hotFalse);
    expect(rowOf('studio.engine.tools').dataset['hot']).toBe('true');
    expect(rowOf('frozen.thing').dataset['hot']).toBe('false');
  });

  it('② required 行没有开关，且显示后端给的 reason', async () => {
    await openPlugins();
    for (const name of ['studio/workspaces', 'studio/sessions', 'studio.engine.llm', 'studio.engine.agent-loop']) {
      expect(switchOf(name), name + ' must not carry a switch').toBeNull();
    }
    // 后端给了原因就别丢（原样透传）。
    expect(rowOf('studio/workspaces').textContent ?? '').toContain('ctx.require(WORKSPACES_SERVICE)');
    expect(rowOf('studio/sessions').textContent ?? '').toContain('every /api/sessions route resolves through it');
    expect(rowOf('studio.engine.agent-loop').textContent ?? '').toContain('no AgentLoop');
    expect(rowOf('studio/workspaces').dataset['disable']).toBe('required');
  });

  it('③ optional 行有开关，拨动调 PUT /api/plugins', async () => {
    await openPlugins();
    const input = switchOf('studio.engine.tools');
    expect(input, 'an optional row must carry a switch').not.toBeNull();
    expect(input!.checked).toBe(true);
    input!.checked = false;
    input!.dispatchEvent(new Ev('change'));
    await flush();
    expect(server.puts.length).toBe(1);
    const sent = server.puts[0] as string[];
    expect(sent).toContain('celestea.runtime.workers'); // 其它行仍开着
    expect(sent).not.toContain('studio.engine.tools'); // 这一行被关掉
    expect(server.rows.find((r) => r['name'] === 'studio.engine.tools')?.['enabled']).toBe(false);
  });

  it('③b idle-only 行同样有开关（没有进行中的会话时可以关）', async () => {
    await openPlugins();
    expect(switchOf('studio/bus')).not.toBeNull();
    expect(switchOf('studio/runtime')).not.toBeNull();
    expect(rowOf('studio/bus').textContent ?? '').toContain('connection point of every SSE stream');
  });

  it('④ 未知 disable 取值如实降级：不画开关、标出原值、不假装认识', async () => {
    await openPlugins();
    const row = rowOf('weird.plugin');
    expect(row.dataset['disable']).toBe('unknown');
    expect(switchOf('weird.plugin'), 'an unknown policy must be fail-closed (no switch)').toBeNull();
    // 不认识就**说出来**：原始取值出现在界面上。
    expect(row.textContent ?? '').toContain('quantum-only');
    // 且不得被当成 optional/idle-only 之一（那两个才有开关）。
    expect(row.textContent ?? '').not.toContain('可以关闭');
    expect(row.textContent ?? '').not.toContain('没有进行中的会话时可以关闭');
  });

  it('⑤ 按 layer 分两段，段内保持服务端给的 mount 顺序', async () => {
    await openPlugins();
    const secs = qa('#settingsPlugins .plug-host-box .plug-cat');
    const layers = secs.map((s) => s.dataset['layer']);
    expect(layers).toEqual(['host', 'engine']);
    const hostNames = Array.from(secs[0]!.querySelectorAll('.plug-host')).map((r) => r.dataset['name']);
    expect(hostNames).toEqual([
      'studio/workspaces', 'studio/sessions', 'studio/bus', 'studio/runtime',
    ]);
    // 引擎层那几行 user 认得出（工具 / worker / swarm / watchdog）现在都在。
    const engineNames = Array.from(secs[1]!.querySelectorAll('.plug-host')).map((r) => r.dataset['name']);
    expect(engineNames).toContain('studio.engine.tools');
    expect(engineNames).toContain('celestea.runtime.workers');
  });

  it('③c PUT 失败：开关回滚到服务端真值，并如实说明', async () => {
    await openPlugins();
    server.failPut = true;
    const input = switchOf('studio.engine.tools')!;
    input.checked = false;
    input.dispatchEvent(new Ev('change'));
    await flush();
    expect(input.checked).toBe(true); // 回滚：服务端真值没变
    expect((q('#settingsPlugins .plug-status')?.textContent ?? '')).not.toBe('');
  });
});
