// @vitest-environment jsdom
/**
 * W-C2 · 设置页「MCP」一格（只读状态面）的 DOM 断言。
 *   ① 各连接状态渲染（连接中 / 就绪 / 失败 / 已停用 / 认不出 → unknown）；
 *   ② 摘要条用**宿主给的聚合计数**，不由前端重算；
 *   ③ 脱敏：env / headers 的值绝不回显（连 fixture 里塞进去的也看不见）；
 *   ④ 配置问题（issues）与「配置读不到」如实显示，不静默；
 *   ⑤ 无状态 ⇒ 空态并指向 mcp.json，且**不给任何编辑控件**；
 *   ⑥ 端点取不到 ⇒ 错误态（不是「空清单」）；
 *   ⑦ 前端铁律 7：pane 切走再切回零重建、零重新请求；
 *   ⑧ 前端铁律 3：连点「重新载入」时晚到的旧应答不覆盖新状态。
 *
 * 取数只有一处（GET /api/plugins 的 mcp 字段），所以全部用例都从这条真实
 * fetch 路径进来，不 mock ui/mcp 自己的解析。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, all, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ConfigMod {
  initSettingsPage(): void;
}
interface I18nMod {
  t(k: string, p?: Record<string, string | number>): string;
  setLocale(l: string): void;
}

const BODY_IDS: Record<string, string> = {
  general: 'settingsGeneral', config: 'settingsConfig', tools: 'settingsTools',
  archive: 'settingsArchive', providers: 'settingsProviders', prompts: 'settingsPrompts',
  permissions: 'settingsPermissions', plugins: 'settingsPlugins', usage: 'settingsUsage',
  mcp: 'settingsMcp',
};
const NAMES = Object.keys(BODY_IDS);

/** 与 index.html 同构的设置页骨架（十格齐全；夹具多写总比少写诚实）。 */
const SETTINGS_HTML =
  '<div id="app"><button id="btnSettingsEntry"></button></div>' +
  '<div id="settingsPage" class="settings-page hidden">' +
  '<button id="btnSettingsReload"></button><button id="btnSettingsClose"></button>' +
  '<nav class="settings-nav">' +
  NAMES.map((n) => '<button class="settings-nav-item" type="button" data-page="' + n + '"></button>').join('') +
  '</nav><div class="settings-content">' +
  NAMES.map((n) =>
    '<section class="settings-pane' + (n === 'config' ? ' active' : '') + '" data-pane="' + n + '">' +
    '<div class="settings-pane-body" id="' + BODY_IDS[n] + '"></div></section>').join('') +
  '</div></div><div id="settingsHint"></div><div id="settingsArchiveCount"></div>' +
  '<div id="settingsArchiveHint"></div><div id="promptsWrap"></div>' +
  // 模块级 need() 的落点（ui/tools.ts / ui/prompts.ts 在 import 期就抓）：缺一个即抛。
  '<span id="toolsCount"></span><button id="btnAddProvider"></button><button id="btnNewPrompt"></button>';

const MCP_PLUGIN = 'studio.engine.mcp';
const OTHER_PLUGIN = { name: 'studio.engine.tools', layer: 'engine', hot: true, enabled: true, disable: 'optional' };

/** 一次 /api/plugins 的应答（mcp = null 即「清单里没有状态面」）。 */
function payload(mcp: unknown): unknown {
  const rows: unknown[] = [OTHER_PLUGIN];
  if (mcp !== null) rows.push({ ...OTHER_PLUGIN, name: MCP_PLUGIN, mcp });
  return { ok: true, plugins: rows };
}

/** 一整块状态面（数字可被单条用例覆写）。 */
function statusOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessions: 1,
    servers: 1,
    tools: 3,
    state: 'ready',
    error: null,
    rows: [{ server: 'memory', session: 's1', transport: 'stdio', state: 'ready', toolCount: 3 }],
    issues: [],
    ...over,
  };
}

const stub = { status: 200, payload: payload(statusOf()), calls: 0, hold: false, gates: [] as Array<() => void> };

function stubFetch(): void {
  vi.stubGlobal('fetch', async (url: unknown) => {
    const u = String(url);
    if (u.startsWith('/api/plugins')) {
      stub.calls += 1;
      // ★ 应答必须在**发请求这一刻**拍下：挂起期间改 stub.payload 会让两次请求拿到
      //   同一份 body，竞态断言就成了空转（W-C2 的变异负控制 M6 实测抓到的正是这个）。
      const body = stub.payload;
      if (stub.hold) await new Promise<void>((r) => stub.gates.push(r));
      return reply(stub.status, body);
    }
    if (u.startsWith('/auth/check')) return reply(401, {});
    if (u.startsWith('/api/config')) return reply(200, { ok: true, model: '', available: { models: [], efforts: [] } });
    if (u.startsWith('/api/status')) return reply(200, { ok: true });
    return reply(404, {});
  });
}

function setup(): void {
  resetHarness();
  doc.body.innerHTML = SETTINGS_HTML;
  localStorage.clear();
  stub.status = 200;
  stub.payload = payload(statusOf());
  stub.calls = 0;
  stub.hold = false;
  stub.gates = [];
  stubFetch();
}

async function boot(): Promise<{ cfg: ConfigMod; i18n: I18nMod }> {
  const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
  i18n.setLocale('zh');
  const cfg = (await import(/* @vite-ignore */ at('ui/config.ts'))) as ConfigMod;
  cfg.initSettingsPage();
  await flush();
  return { cfg, i18n };
}

/** 点左导航的某一格（真装配路径，不直接调 loadMcpSection）。 */
async function goto(page: string): Promise<void> {
  (doc.querySelector('.settings-nav-item[data-page="' + page + '"]') as ElLike)
    .dispatchEvent(new Ev('click', { bubbles: true }));
  await flush();
}

const box = (): ElLike => doc.getElementById('settingsMcp') as ElLike;
const paneText = (): string => box().textContent ?? '';
const mcpRows = (): ElLike[] => all('#settingsMcp .mcp-row');

describe('W-C2 · 设置页「MCP」只读状态面', () => {
  beforeEach(setup);
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); localStorage.clear(); });

  it('五种连接状态各渲染成对应文案与 data-state；认不出的归 unknown', async () => {
    const { i18n } = await boot();
    stub.payload = payload(statusOf({ servers: 5, tools: 0, state: 'failed', rows: [
      { server: 'a', session: 's1', transport: 'stdio', state: 'ready', toolCount: 3 },
      { server: 'b', session: 's1', transport: 'http', state: 'connecting', toolCount: 0 },
      { server: 'c', session: null, transport: 'stdio', state: 'failed', toolCount: 0, failureKind: 'connect_failed' },
      { server: 'd', session: 's1', transport: 'http', state: 'disabled', toolCount: 0 },
      { server: 'e', session: 's1', transport: 'stdio', state: 'teleporting', toolCount: 0 },
    ] }));
    await goto('mcp');
    const rows = mcpRows();
    expect(rows.length).toBe(5);
    expect(rows.map((r) => r.dataset['state'])).toEqual(['ready', 'connecting', 'failed', 'disabled', 'unknown']);
    const badge = (i: number): string => rows[i]?.querySelector('.mcp-state')?.textContent ?? '';
    expect(badge(0)).toBe(i18n.t('settings.mcp.state.ready'));
    expect(badge(1)).toBe(i18n.t('settings.mcp.state.connecting'));
    expect(badge(2)).toBe(i18n.t('settings.mcp.state.failed'));
    expect(badge(3), '已停用是封闭集里的一格').toBe(i18n.t('settings.mcp.state.disabled'));
    expect(badge(4), '认不出的状态绝不按乐观方向猜').toBe(i18n.t('settings.mcp.state.unknown'));
    // 传输徽标：契约里没有 command/url，所以显示传输本身，不编一个命令出来。
    expect(rows[0]?.querySelector('.mcp-badge')?.textContent).toBe(i18n.t('settings.mcp.transport', { value: 'stdio' }));
    expect(rows[1]?.querySelector('.mcp-badge')?.textContent).toBe(i18n.t('settings.mcp.transport', { value: 'http' }));
  });

  it('摘要条用宿主给的聚合计数（不由前端按行重算）', async () => {
    const { i18n } = await boot();
    stub.payload = payload(statusOf({ sessions: 2, servers: 5, tools: 11, rows: [
      { server: 'a', session: 's1', transport: 'stdio', state: 'ready', toolCount: 3 },
      { server: 'b', session: 's2', transport: 'stdio', state: 'ready', toolCount: 4 },
    ] }));
    await goto('mcp');
    const bar = box().querySelector('.mcp-bar');
    expect(bar?.textContent).toBe(i18n.t('settings.mcp.summary', { servers: '5', tools: '11', sessions: '2' }));
    // 每行自己的工具数照实显示（两条 = 7，与摘要的 11 不同也不被「修正」）。
    expect(mcpRows()[0]?.querySelector('.mcp-row-hint')?.textContent).toContain(i18n.t('settings.mcp.tools', { n: '3' }));
    expect(mcpRows()[1]?.querySelector('.mcp-row-hint')?.textContent).toContain(i18n.t('settings.mcp.tools', { n: '4' }));
  });

  it('失败行给失败分类 + 明细；env / headers 的值绝不回显', async () => {
    const { i18n } = await boot();
    stub.payload = payload(statusOf({ state: 'failed', rows: [{
      server: 'memory', session: 's1', transport: 'stdio', state: 'failed', toolCount: 0,
      failureKind: 'connect_failed', failureDetail: 'spawn ENOENT npx',
      env: { MCP_TOKEN: 'sk-do-not-echo' }, headers: { Authorization: 'Bearer sk-do-not-echo-either' },
    }] }));
    await goto('mcp');
    const row = mcpRows()[0] as ElLike;
    expect(row.dataset['failure']).toBe('connect_failed');
    const why = row.querySelector('.mcp-row-reason')?.textContent ?? '';
    expect(why).toContain(i18n.t('settings.mcp.failure.connect_failed'));
    expect(why).toContain('spawn ENOENT npx');
    expect(paneText(), 'fixture 里的凭据一个字都不许出现').not.toContain('sk-do-not-echo');
    expect(paneText()).not.toContain('headers');
  });

  it('配置问题逐条列出（kind 进 data-kind，坏配置不静默）', async () => {
    await boot();
    stub.payload = payload(statusOf({ state: 'idle', rows: [], issues: [
      { kind: 'invalid_entry', server: 'remote', message: "stdio carries 'url'" },
      { kind: 'unknown_reference', message: 'references $NOPE that is not set' },
    ] }));
    await goto('mcp');
    const issues = all('#settingsMcp .mcp-issue');
    expect(issues.map((i) => i.dataset['kind'])).toEqual(['invalid_entry', 'unknown_reference']);
    expect(issues[0]?.textContent).toContain('remote');
    expect(issues[0]?.textContent).toContain('stdio carries');
    expect(issues[1]?.textContent, '没有 server 的那条也必须显示').toContain('references $NOPE');
  });

  it('配置读不到（mcp.json 坏了）⇒ 如实显示，不静默', async () => {
    const { i18n } = await boot();
    stub.payload = payload(statusOf({ state: 'idle', rows: [], error: "mcp.json is unreadable: bad token at 3:4" }));
    await goto('mcp');
    const note = box().querySelector('.mcp-note.err');
    expect(note, '坏配置必须有一行错误说明').not.toBeNull();
    expect(note?.textContent).toContain('bad token at 3:4');
    expect(note?.textContent).toContain(i18n.t('settings.mcp.configError', { message: '' }).split('{')[0] ?? '');
  });

  it('没有状态面 ⇒ 空态指向 mcp.json，且**不提供任何编辑控件**', async () => {
    await boot();
    stub.payload = payload(null); // 清单里没有 mcp 字段（没配 / 全关 / 服务早于 MCP）
    await goto('mcp');
    const empty = box().querySelector('.mcp-empty');
    expect(empty, '必须有如实空态').not.toBeNull();
    expect(empty?.classList.contains('err'), '这不是错误').toBe(false);
    expect(empty?.textContent).toContain('mcp.json');
    expect(all('#settingsMcp input, #settingsMcp button, #settingsMcp select, #settingsMcp textarea').length,
      '只读状态面不给编辑 UI（docs §12 U11 属 P1）').toBe(0);
  });

  it('端点取不到 ⇒ 错误态（而不是「空清单」）', async () => {
    await boot();
    stub.status = 404;
    await goto('mcp');
    const empty = box().querySelector('.mcp-empty');
    expect(empty?.classList.contains('err'), '取不到状态与「没有配置」必须分得开').toBe(true);
    expect(empty?.textContent).toContain('MCP');
    expect(mcpRows().length).toBe(0);
  });

  it('前端铁律 7：pane 切走再切回零重建、零重新请求', async () => {
    await boot();
    stub.payload = payload(statusOf({ rows: [{ server: 'memory', session: 's1', transport: 'stdio', state: 'ready', toolCount: 3 }] }));
    await goto('mcp');
    const first = mcpRows()[0];
    const calls = stub.calls;
    await goto('config');
    await goto('mcp');
    expect(stub.calls, '切回不得重新取数').toBe(calls);
    expect(mcpRows()[0], '切回不得重建行（同一个节点）').toBe(first);
    expect((doc.querySelector('.settings-pane[data-pane="mcp"]') as ElLike).classList.contains('active')).toBe(true);
  });

  it('前端铁律 3：连点「重新载入」，晚到的旧应答不覆盖新状态', async () => {
    await boot();
    stub.payload = payload(statusOf({ rows: [{ server: 'stale', session: 's1', transport: 'stdio', state: 'ready', toolCount: 1 }] }));
    await goto('mcp');
    expect(mcpRows()[0]?.dataset['server']).toBe('stale');
    // 从这一刻起把应答挂起：两次「重新载入」都会停在半路。
    stub.hold = true;
    stub.payload = payload(statusOf({ rows: [{ server: 'older', session: 's1', transport: 'stdio', state: 'ready', toolCount: 1 }] }));
    const reload = doc.getElementById('btnSettingsReload') as ElLike;
    reload.dispatchEvent(new Ev('click', { bubbles: true }));      // 第一次「重新载入」挂起
    stub.payload = payload(statusOf({ rows: [{ server: 'fresh', session: 's1', transport: 'stdio', state: 'ready', toolCount: 1 }] }));
    reload.dispatchEvent(new Ev('click', { bubbles: true }));      // 第二次，带着新状态
    await flush();
    expect(stub.gates.length, '两次重新载入都挂起了').toBe(2);
    (stub.gates[1] ?? (() => undefined))();                       // 先放行**新**的
    await flush();
    expect(mcpRows()[0]?.dataset['server']).toBe('fresh');
    (stub.gates[0] ?? (() => undefined))();                       // 再放行旧的（迟到的）
    await flush();
    expect(mcpRows()[0]?.dataset['server'], '旧结果必须被丢弃').toBe('fresh');
  });

  it('英文界面下这一格出的是英文文案，不是裸 key', async () => {
    const { i18n } = await boot();
    i18n.setLocale('en');
    await goto('mcp');
    const badge = mcpRows()[0]?.querySelector('.mcp-state')?.textContent ?? '';
    expect(badge).toBe('Ready');
    expect(badge).not.toBe('settings.mcp.state.ready');
  });
});
