// @vitest-environment jsdom
/**
 * W9103 · DOM 断言（jsdom）：
 *   ① 顶栏**不再**有 #btnConfig（机械防回归）；
 *   ② 左下角设置入口存在，含图标 + 「设置」文案 + 用户名；整块可点 ⇒ 打开设置页；
 *   ③ 用户名超长单行截断（CSS 类 + 不撑破侧栏的判据）；
 *   ④ 未登录（401）时不显示用户名（不编占位名）；
 *   ⑤ 设置页有「使用统计」入口且可切；pane 渲染出摘要条 + 热力图 + 折线图；
 *   ⑥ 账本 ok:false（disabled / unavailable）时显示**降级说明**，不画假图。
 *
 * ★ W9220（测试提速，用例与断言逐字未动）：本文件是原 ~tests/w9103-usage-panel-dom.test.ts~
 *   的**~左下角设置入口部分~**。原文件 16 条、单条 0.05–1.07s、文件 4.0–4.7s；vitest 以**文件**为
 *   调度单位，拆开后两部分可并行。夹具（~HTML~/~ledgerStub~/~setup~/~boot~/
 *   ~openUsagePane~ 等）逐字复制自原文件，每个新文件都带**自己的** beforeEach(setup)
 *   重置（W9219 的教训：共享夹具 + 缺重置 = 跨文件泄漏）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ConfigMod {
  initSettingsPage(): void;
  openSettings(): void;
  closeSettings(): void;
}

/** 与真实 index.html 同构的设置页骨架（含 W9103 新增的 usage 格与左下角入口）。 */
const HTML =
  '<div id="app"><div id="layout"><aside id="sidebar">' +
  '<div class="side-body" id="sessionTree"></div>' +
  '<section class="side-sec side-sec-foot"><div class="side-note" id="sideFoot">—</div>' +
  '<button id="btnSettingsEntry" class="side-settings" type="button" ' +
  'data-i18n-title="shell.sidebar.settingsTitle" data-i18n-aria-label="shell.sidebar.settingsAria">' +
  '<svg class="side-settings-ico" viewBox="0 0 16 16"></svg>' +
  '<span class="side-settings-text" data-i18n="shell.sidebar.settings"></span>' +
  '<span class="side-settings-user hidden" id="settingsUser"></span>' +
  '</button></section></aside>' +
  '<main id="main"><div id="messages"></div></main></div></div>' +
  '<div id="settingsPage" class="settings-page hidden">' +
  '<nav class="settings-nav">' +
  '<button class="settings-nav-item" type="button" data-page="general" data-i18n="settings.general.title"></button>' +
  '<button class="settings-nav-item" type="button" data-page="config">通用配置</button>' +
  '<button class="settings-nav-item" type="button" data-page="tools"></button>' +
  '<button class="settings-nav-item" type="button" data-page="archive"></button>' +
  '<button class="settings-nav-item" type="button" data-page="providers"></button>' +
  '<button class="settings-nav-item" type="button" data-page="prompts"></button>' +
  '<button class="settings-nav-item" type="button" data-page="permissions"></button>' +
  '<button class="settings-nav-item" type="button" data-page="plugins"></button>' +
  '<button class="settings-nav-item" type="button" data-page="usage" data-i18n="usage.nav.title"></button>' +
  '</nav>' +
  '<section class="settings-pane" data-pane="general"><h4 data-i18n="settings.general.title"></h4><div class="settings-pane-body" id="settingsGeneral"></div></section>' +
  '<section class="settings-pane active" data-pane="config"><div id="settingsConfig"></div><div id="settingsHint"></div></section>' +
  '<section class="settings-pane" data-pane="tools"><span id="toolsCount"></span><div id="settingsTools"></div></section>' +
  '<section class="settings-pane" data-pane="archive"><span id="settingsArchiveCount"></span><div id="settingsArchive"></div><div id="settingsArchiveHint"></div></section>' +
  '<section class="settings-pane" data-pane="providers"><div id="settingsProviders"></div></section>' +
  '<section class="settings-pane" data-pane="prompts"><div id="promptsWrap"></div><div id="settingsPrompts"></div></section>' +
  '<section class="settings-pane" data-pane="permissions"><div id="settingsPermissions"></div></section>' +
  '<section class="settings-pane" data-pane="plugins"><div id="settingsPlugins"></div></section>' +
  '<section class="settings-pane" data-pane="usage"><div class="settings-pane-body" id="settingsUsage"></div></section>' +
  '<button id="btnSettingsClose"></button><button id="btnSettingsReload"></button>' +
  '<button id="btnAddProvider"></button><button id="btnNewPrompt"></button>' +
  '</div>';

/** 账本桩：默认给两天真实数据（照本机 3777 实测的形状）。 */
const ledgerStub = {
  ok: true as boolean,
  error: '' as string,
  rows: [
    {
      key: '2026-09-19',
      tokens: { prompt_tokens: 462229, completion_tokens: 20572, total_tokens: 482801, cache_read: 420736, reasoning_tokens: 5910 },
      cost: null,
      records: 41,
      unpriced_records: 36,
    },
    { key: '2026-09-25', tokens: { total_tokens: 1000 }, cost: null, records: 2, unpriced_records: 0 },
  ] as unknown[],
  unpriced_models: ['deepseek-flash'] as string[],
  totalsCost: null as number | null,
};
const authStub = { status: 200, user: 'alice' };
/** `group_by=day_model` 的状态码：422 = 老服务不认这个维度（触发逐日开窗回退）。 */
const dayModelStub = { status: 200 };
/** 实际发出的账本请求 URL（回退路径的机械判据）。 */
let ledgerCalls: string[] = [];

const entry = (): ElLike => doc.getElementById('btnSettingsEntry') as ElLike;
const userNode = (): ElLike => doc.getElementById('settingsUser') as ElLike;
const usagePane = (): ElLike => doc.querySelector('.settings-pane[data-pane="usage"]') as ElLike;

function stubFetch(): void {
  vi.stubGlobal('fetch', async (url: unknown) => {
    const u = String(url);
    if (u.startsWith('/auth/check')) {
      return authStub.status === 200
        ? reply(200, { ok: true, user: authStub.user })
        : reply(authStub.status, { ok: false });
    }
    if (u.startsWith('/api/usage/ledger')) {
      ledgerCalls.push(u);
      if (!ledgerStub.ok) return reply(200, { ok: false, error: ledgerStub.error });
      const group = /group_by=([a-z_]+)/.exec(u)?.[1] ?? 'day';
      if (group === 'model') {
        return reply(200, { ok: true, currency: 'CNY', group_by: 'model', rows: [
          { key: 'deepseek-flash', tokens: { total_tokens: 482801 }, cost: null, records: 41, unpriced_records: 36 },
        ] });
      }
      // 主路径：一次拿全区间（day×model 交叉维度）。
      if (group === 'day_model') {
        if (dayModelStub.status !== 200) {
          return reply(dayModelStub.status, { error: "field 'group_by' must be one of session, turn, model, day" });
        }
        return reply(200, { ok: true, currency: 'CNY', group_by: 'day_model', rows: [
          { key: '2026-09-19|deepseek-flash', tokens: { total_tokens: 482801 }, cost: null, records: 41, unpriced_records: 36 },
        ] });
      }
      // 「最长聊天时长」的来源：每行的 first_ts/last_ts（跨度 28502 秒）。
      if (group === 'session') {
        return reply(200, { ok: true, currency: 'CNY', group_by: 'session', rows: [
          { key: 'ws/test', tokens: { total_tokens: 482801 }, cost: null, records: 41, unpriced_records: 36, first_ts: 1789799886, last_ts: 1789828262 },
        ] });
      }
      return reply(200, {
        ok: true,
        currency: 'CNY',
        group_by: 'day',
        rows: ledgerStub.rows,
        totals: { cost: ledgerStub.totalsCost, unpriced_models: ledgerStub.unpriced_models },
        unpriced_models: ledgerStub.unpriced_models,
        price_version: null,
      });
    }
    if (u.startsWith('/api/status')) return reply(200, { ok: true });
    if (u.startsWith('/api/config')) return reply(200, { ok: true, model: '', available: { models: [] } });
    return reply(404, { ok: false });
  });
}

async function boot(): Promise<ConfigMod> {
  const cfg = (await import(/* @vite-ignore */ at('ui/config.ts'))) as ConfigMod;
  cfg.initSettingsPage();
  await flush();
  return cfg;
}

/** 每个 describe 各自建夹具（本仓 eslint 对 tests/** 的单函数上限 150 行）。 */
function setup(): void {
  resetHarness();
  doc.body.innerHTML = HTML;
  ledgerStub.ok = true;
  ledgerStub.error = '';
  ledgerStub.totalsCost = null;
  ledgerStub.rows = [
    { key: '2026-09-19', tokens: { total_tokens: 482801 }, cost: null, records: 41, unpriced_records: 36 },
    { key: '2026-09-25', tokens: { total_tokens: 1000 }, cost: null, records: 2, unpriced_records: 0 },
  ];
  authStub.status = 200;
  authStub.user = 'alice';
  dayModelStub.status = 200;
  ledgerCalls = [];
  stubFetch();
}


describe('W9103 · 左下角设置入口', () => {
  beforeEach(setup);
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('顶栏不再有 #btnConfig（机械防回归）', async () => {
    await boot();
    // 真实 index.html 也一并断言（夹具只是骨架，真源是 index.html）。
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const html = readFileSync(join(process.cwd(), 'apps', 'web', 'index.html'), 'utf8');
    expect(html.includes('btnConfig'), 'index.html 不得再有 #btnConfig').toBe(false);
    expect(doc.getElementById('btnConfig'), 'DOM 里也不得有').toBeNull();
  });

  it('左下角入口存在：图标 + 「设置」文案 + 用户名', async () => {
    await boot();
    expect(entry(), '入口必须存在').not.toBeNull();
    expect(entry().querySelector('svg.side-settings-ico'), '内联 SVG 图标').not.toBeNull();
    // 文案走 i18n（data-i18n key 在标记上，值由 applyI18n 填）。
    const text = entry().querySelector('.side-settings-text') as ElLike;
    expect(text.getAttribute('data-i18n')).toBe('shell.sidebar.settings');
    expect(text.textContent, '中文界面下显示「设置」').toBe('设置');
    expect(userNode().textContent, '用户名来自登录态').toBe('alice');
    expect(userNode().classList.contains('hidden'), '取到用户名 ⇒ 摘掉 hidden').toBe(false);
  });

  it('用户名超长单行截断（不撑破侧栏）', async () => {
    authStub.user = 'a-very-long-user-name-that-would-otherwise-blow-up-the-sidebar-'.repeat(3);
    await boot();
    // 截断由 CSS 承担：min-width:0 + overflow:hidden + text-overflow:ellipsis + nowrap。
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(process.cwd(), 'apps', 'web', 'src', 'styles', 'layout.css'), 'utf8');
    const rule = /\.side-settings-user\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule, '.side-settings-user 规则必须存在').not.toBe('');
    expect(rule).toContain('text-overflow: ellipsis');
    expect(rule).toContain('overflow: hidden');
    expect(rule).toContain('white-space: nowrap');
    expect(rule).toContain('min-width: 0');
    // jsdom 不做布局：scrollWidth/clientWidth 恒 0，故这里断言**类与样式**（真机几何
    // 由 CDP 断言，见报告的真机证据一节）。
    expect(userNode().className).toContain('side-settings-user');
  });

  it('未登录（401）⇒ 不显示用户名，也不编占位名', async () => {
    authStub.status = 401;
    await boot();
    expect(userNode().classList.contains('hidden'), '401 ⇒ 保持隐藏').toBe(true);
    expect(userNode().textContent, '不得编占位名').toBe('');
    expect(userNode().title ?? '').toBe('');
    // 图标 + 「设置」仍在（入口本身不因未登录而消失）。
    expect(entry().querySelector('svg.side-settings-ico')).not.toBeNull();
    expect((entry().querySelector('.side-settings-text') as ElLike).textContent).toBe('设置');
  });

  it('登录态答了 200 但没有 user 字段 ⇒ 仍不显示用户名（契约里 user 是可选的）', async () => {
    // 契约 get_auth_check 的 `user` 是 required:false —— 成功应答也可能不带用户名。
    // 这是「不编占位名」最容易破的一格：把空值当名字写进去就会显示成空白格或假名。
    authStub.status = 200;
    authStub.user = '';
    await boot();
    expect(userNode().classList.contains('hidden'), '空用户名 ⇒ 保持隐藏').toBe(true);
    expect(userNode().textContent?.trim() ?? '', '不得把空值当名字写进去').toBe('');
    // 只有非空用户名才摘掉 hidden（对照：这一条与上面两条构成完整口径）。
    authStub.user = 'bob';
    await boot();
    expect(userNode().classList.contains('hidden')).toBe(false);
    expect(userNode().textContent).toBe('bob');
  });

  it('点左下角入口真的打开设置页（整块可点）', async () => {
    await boot();
    expect(doc.getElementById('settingsPage')?.classList.contains('hidden'), '初始为关').toBe(true);
    entry().dispatchEvent(new Ev('click', { bubbles: true }));
    expect(doc.getElementById('settingsPage')?.classList.contains('hidden'), '点它 ⇒ 打开').toBe(false);
  });

  it('设置页有「使用统计」入口且可切到该 pane', async () => {
    await boot();
    const nav = doc.querySelector('.settings-nav-item[data-page="usage"]') as ElLike;
    expect(nav, 'nav 项必须存在').not.toBeNull();
    expect(nav.getAttribute('data-i18n')).toBe('usage.nav.title');
    nav.dispatchEvent(new Ev('click', { bubbles: true }));
    expect(usagePane().classList.contains('active')).toBe(true);
    expect(doc.querySelector('.settings-pane[data-pane="config"]')?.classList.contains('active')).toBe(false);
  });
});

/** 分组 2：「使用统计」pane 的内容与降级（同样每个 describe 自带夹具）。 */
