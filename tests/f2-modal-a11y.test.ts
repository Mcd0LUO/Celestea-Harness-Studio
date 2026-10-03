// @vitest-environment jsdom
/**
 * F2-01 / F2-02：模态背景隔离 + 主输入框可访问名。
 *
 * F2-01：#settingsPage 声明了 role=dialog aria-modal=true，修复前背景既不 inert 也不
 *        可聚焦隔离（真机 CDP 实测 Tab×20 有 9 次落进背景、背景输入框真能写入）。
 *        这里钉住「打开时背景 inert 且焦点进得来、关闭时必须摘干净」。
 * F2-02：#input 只有 placeholder（HTML-AAM 里 placeholder 只是 fallback，不是可访问名），
 *        且 placeholder 就是操作说明、一打字就消失。钉住 aria-label 由 i18n 填上。
 *
 * 两条加载纪律（收口时定的，别改回去）：
 *   1. 一律走 tests/lib/w795-dom.ts 的 at(rel) 动态加载器 + 本文件自定义的窄接口，
 *      不得写 typeof import('../apps/web/src/...')。那是类型级静态导入 —— 根 tsconfig
 *      的 include 含整个 tests 目录（NodeNext + 无 DOM lib），于是整棵 apps/web 被拖进
 *      根 tsc 工程，爆出满屏 TS2835/TS2304；depcruise 同理把 apps/web 拉进 cruise 并
 *      触发 4 个 no-circular。动态 import + 窄接口只留下字符串，tsc 与 depcruise 都看不见它。
 *      范式抄 tests/w9-permission-ui.test.ts 第 92 行那一处。
 *   2. 不得直接用 DOM 全局类型（HTMLElement / Document / document / ParentNode）：根
 *      tsconfig 的 lib 里没有 DOM（那是 apps/web 自己的 tsconfig 才开的），本仓 web
 *      测试一律经夹具的 doc / ElLike 访问 DOM，或声明本文件自己的结构化窄类型。
 */
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, type ElLike } from './lib/w795-dom.js';

/**
 * 元素窄类型：在夹具的 ElLike 之上补上本测试真正用到的那几个成员
 * （hasAttribute / removeAttribute / focus / children）。刻意不扩到 HTMLElement ——
 * 扩满等于把 DOM lib 又请回来，根 tsc 会重新报满屏 TS2304。
 */
interface FocusEl extends ElLike {
  hasAttribute(k: string): boolean;
  removeAttribute(k: string): void;
  focus(): void;
  children: ArrayLike<ElLike>;
}

/** 背景隔离的句柄（modal-bg.ts 的 BackgroundHandle）。 */
interface BgHandle {
  nodes: readonly ElLike[];
  restore: () => void;
}

interface ModalBgMod {
  /**
   * 第三个形参是 F2-07-01 新增的 exclude（排除「浮层自己的关闭控件」）。这里声明成
   * 窄类型而不是 ReadonlySet<Element> —— 根 tsconfig 的 lib 里没有 DOM。
   */
  isolateBackground(
    keep: FocusEl,
    before?: () => void,
    exclude?: ReadonlySet<ElLike>,
  ): BgHandle;
  firstFocusable(keep: FocusEl): FocusEl | null;
}

interface ConfigMod {
  openSettings(): void;
  closeSettings(): void;
}

interface I18nDomMod {
  /** 形参是 ParentNode（DOM 侧类型）；根工程无 DOM lib，故这里收 unknown。 */
  applyI18n(root: unknown): void;
}

interface LocaleChat {
  chat: Record<string, string>;
}

/**
 * 仓库根：从本文件位置反推，**不得写死本机绝对路径**。
 * 写死只在作者本机成立 —— CI runner 上必然 ENOENT（main run 37133961564 即因此变红），
 * 而本地因为那个路径真实存在反而全绿，属「把本机事实当普遍事实」（同 17cacfc 那一类）。
 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 取一个元素并收窄成 FocusEl。 */
const el = (id: string): FocusEl => doc.getElementById(id) as unknown as FocusEl;

const setBody = (html: string): void => {
  doc.body.innerHTML = html;
};

const activeId = (): string => {
  const d = doc as unknown as { activeElement: FocusEl | null };
  return d.activeElement ? d.activeElement.id : '';
};

const loadModalBg = async (): Promise<ModalBgMod> =>
  (await import(/* @vite-ignore */ at('utils/modal-bg.ts'))) as unknown as ModalBgMod;
const loadConfig = async (): Promise<ConfigMod> =>
  (await import(/* @vite-ignore */ at('ui/config.ts'))) as unknown as ConfigMod;
const loadI18nDom = async (): Promise<I18nDomMod> =>
  (await import(/* @vite-ignore */ at('i18n/dom.ts'))) as unknown as I18nDomMod;
const loadZhChat = async (): Promise<LocaleChat> =>
  (await import(/* @vite-ignore */ at('i18n/locales/zh/chat.ts'))) as unknown as LocaleChat;
const loadEnChat = async (): Promise<LocaleChat> =>
  (await import(/* @vite-ignore */ at('i18n/locales/en/chat.ts'))) as unknown as LocaleChat;

const MODAL_HTML =
  '<div id="settingsPage" class="settings-page hidden" role="dialog" aria-modal="true">' +
  '<div class="settings-shell"><header><button id="closeBtn">x</button></header></div></div>';

const NAV = [
  'general', 'config', 'tools', 'archive', 'providers',
  'prompts', 'permissions', 'plugins', 'usage',
].map((p) => '<button class="settings-nav-item" data-page="' + p + '">' + p + '</button>').join('');

const PANES = [
  '<section class="settings-pane" data-pane="general"><div id="settingsGeneral"></div></section>',
  '<section class="settings-pane active" data-pane="config"><div id="settingsConfig"></div><div id="settingsHint"></div></section>',
  '<section class="settings-pane" data-pane="tools"><span id="toolsCount"></span><div id="settingsTools"></div></section>',
  '<section class="settings-pane" data-pane="archive"><div id="settingsArchive"></div><div id="settingsArchiveHint"></div></section>',
  '<section class="settings-pane" data-pane="providers"><div id="settingsProviders"></div></section>',
  '<section class="settings-pane" data-pane="prompts"><div id="settingsPrompts"></div><div id="promptsWrap"></div></section>',
  '<section class="settings-pane" data-pane="permissions"><div id="settingsPermissions"></div></section>',
  '<section class="settings-pane" data-pane="plugins"><div id="settingsPlugins"></div></section>',
  '<section class="settings-pane" data-pane="usage"><div id="settingsUsage"></div></section>',
].join('');

const FULL_SETTINGS_HTML =
  '<div id="app"><button id="btnSettingsEntry">设置</button></div>' +
  '<div id="settingsPage" class="settings-page hidden" role="dialog" aria-modal="true">' +
  '<div class="settings-shell"><header>' +
  '<button id="btnSettingsReload">r</button><button id="btnSettingsClose">x</button>' +
  '</header><div class="settings-layout">' +
  '<nav class="settings-nav">' + NAV + '</nav>' + PANES +
  '</div></div></div>';

describe('F2-01 · 模态态的背景隔离（inert）', () => {
  let isolate: ModalBgMod;

  beforeEach(async () => {
    setBody(
      '<div id="app"><button id="bgBtn">bg</button>' +
        '<textarea id="bgInput"></textarea></div>' +
        MODAL_HTML,
    );
    isolate = await loadModalBg();
  });

  afterEach(() => {
    setBody('');
    vi.restoreAllMocks();
  });

  const page = (): FocusEl => el('settingsPage');
  const app = (): FocusEl => el('app');

  it('打开时把背景兄弟子树置 inert（Tab 进不去、读屏不读）', () => {
    isolate.isolateBackground(page());
    expect(app().hasAttribute('inert')).toBe(true);
  });

  it('不把 modal 自身置 inert', () => {
    isolate.isolateBackground(page());
    expect(page().hasAttribute('inert')).toBe(false);
  });

  it('置 inert 之前先把焦点收进 modal（否则焦点被甩到 body）', () => {
    const bgBtn = el('bgBtn');
    bgBtn.focus();
    expect(activeId()).toBe('bgBtn');
    isolate.isolateBackground(page(), () => {
      const first = isolate.firstFocusable(page());
      if (first) first.focus();
    });
    expect(activeId()).toBe('closeBtn');
  });

  it('空 modal（无可聚焦子节点）时焦点仍收得进来，退回容器本身', () => {
    // 覆盖 firstFocusable 的兜底分支：modal 里一个可聚焦元素都没有时，靠 keep 上的
    // tabindex="-1" 接住焦点。若此时返回 null，焦点就留在背景里（W9310 变异 M5 实测）。
    setBody('<div id="app"><button id="bgBtn2">bg</button></div><div id="settingsPage"></div>');
    const empty = el('settingsPage');
    const bg = el('bgBtn2');
    bg.focus();
    const h = isolate.isolateBackground(empty, () => {
      const first = isolate.firstFocusable(empty);
      if (first) first.focus();
    });
    expect(activeId()).toBe('settingsPage');
    expect(empty.getAttribute('tabindex')).toBe('-1');
    h.restore();
  });

  it('restore 摘掉 inert —— 漏摘会把整个应用变成一块砖', () => {
    const h = isolate.isolateBackground(page());
    expect(app().hasAttribute('inert')).toBe(true);
    h.restore();
    expect(app().hasAttribute('inert')).toBe(false);
  });

  it('restore 幂等：重复调用不抛错', () => {
    const h = isolate.isolateBackground(page());
    h.restore();
    expect(() => h.restore()).not.to.throw();
  });

  it('不覆盖别人已经设的 inert（那属于另一层浮层）', () => {
    // 必须是 modal 的兄弟：isolateBackground 只遍历 keep.parentElement 的 children，
    // 挂到 #app 里面去的那层永远轮不到，断言会空转成永远绿（W9310 变异 M2 实测）。
    const other = doc.createElement('div') as unknown as FocusEl;
    other.id = 'otherLayer';
    other.setAttribute('inert', '');
    page().parentElement?.appendChild(other);
    const h = isolate.isolateBackground(page());
    h.restore();
    // 关键：restore 只摘「由我们改的」，别把别的层已隔离好的摘掉
    expect(other.hasAttribute('inert')).toBe(true);
  });
});

describe('F2-07-01 · isolateBackground 的 exclude：浮层自己的控件不是背景', () => {
  // 背景：#layer 下并排放 keep、一个真背景、一个「浮层自己的关闭控件」。
  let isolate: ModalBgMod;

  beforeEach(async () => {
    setBody(
      '<div id="layer">' +
        '<div id="keep"></div>' +
        '<div id="scrim"></div>' +
        '<div id="bg"></div>' +
        '</div>',
    );
    isolate = await loadModalBg();
  });

  afterEach(() => setBody(''));

  it('不传 exclude 时行为不变：兄弟里除 keep 外全部置 inert', () => {
    isolate.isolateBackground(el('keep'));
    expect(el('scrim').hasAttribute('inert')).toBe(true);
    expect(el('bg').hasAttribute('inert')).toBe(true);
  });

  it('exclude 里的兄弟不被置 inert —— 点它关浮层必须还能生效', () => {
    isolate.isolateBackground(el('keep'), undefined, new Set([el('scrim')]));
    expect(el('scrim').hasAttribute('inert')).toBe(false);
    expect(el('bg').hasAttribute('inert')).toBe(true);
  });

  it('被 exclude 的节点不进句柄 ⇒ restore 只还原本次真改过的', () => {
    const h = isolate.isolateBackground(el('keep'), undefined, new Set([el('scrim')]));
    // 句柄里必须没有它：restore 是「按 nodes 逐个摘」，混进去就会误伤别人设的 inert。
    expect(h.nodes.map((n) => n.id)).not.toContain('scrim');
    h.restore();
    expect(el('bg').hasAttribute('inert')).toBe(false);
    expect(el('scrim').hasAttribute('inert')).toBe(false);
  });

  it('exclude 不妨碍 before 回调：它照样被调用一次', () => {
    // 只钉「回调被调用」这一条，不钉它相对 inert 的先后。
    //
    // 原因：modal-bg.ts 的注释曾写「置 inert 之前收焦点、顺序不能反」，而代码一直是
    // 循环先置 inert、回调后跑。两种顺序的终态相同（keep 自己不在被隔离的名单里，
    // 两种情况下对 keep 内部 focus() 都有效），真机 390x844 也已验证焦点正确落进设置页
    // （results/audit4/F2/probe-A.json 的 P1_open）。所以此处刻意不断言顺序 ——
    // 把一条未兑现的注释约束成断言，只会在将来有人「顺手调顺序」时给出假信号。
    let calls = 0;
    isolate.isolateBackground(el('keep'), () => { calls += 1; }, new Set([el('scrim')]));
    expect(calls).toBe(1);
    expect(el('scrim').hasAttribute('inert')).toBe(false);
    expect(el('bg').hasAttribute('inert')).toBe(true);
  });

  it('exclude 命中不了的节点（不在兄弟里）不影响任何事', () => {
    // 传一个不在这层里的节点：不能误伤，也必须照常隔离真正的背景。
    isolate.isolateBackground(el('keep'), undefined, new Set([el('scrim'), el('nowhere')]));
    expect(el('bg').hasAttribute('inert')).toBe(true);
    expect(el('keep').hasAttribute('inert')).toBe(false);
  });
});

describe('F2-01 · openSettings/closeSettings 成对摘除', () => {
  beforeEach(() => {
    setBody(FULL_SETTINGS_HTML);
  });

  afterEach(() => {
    setBody('');
    vi.restoreAllMocks();
  });

  it('打开后背景 inert，关闭后一定摘干净', async () => {
    const jsonResponse = new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse));
    const mod = await loadConfig();
    const app = el('app');
    const page = el('settingsPage');

    mod.openSettings();
    expect(page.classList.contains('hidden')).toBe(false);
    expect(app.hasAttribute('inert')).toBe(true);

    mod.closeSettings();
    expect(page.classList.contains('hidden')).toBe(true);
    expect(app.hasAttribute('inert')).toBe(false);
  });
});

describe('F2-02 · #input 的稳定可访问名', () => {
  afterEach(() => {
    setBody('');
  });

  it('index.html 上带 data-i18n-aria-label，且不含中文字面量', () => {
    const html = readFileSync(ROOT + '/apps/web/index.html', 'utf8');
    const line = html.split('\n').find((l) => l.includes('id="input"')) ?? '';
    expect(line).toContain('data-i18n-aria-label="chat.input.ariaLabel"');
  });

  it('zh/en 字典都有 chat.input.ariaLabel，且不是 key 回落', async () => {
    const zh = (await loadZhChat()).chat;
    const en = (await loadEnChat()).chat;
    const z = zh['chat.input.ariaLabel'] ?? '';
    const e = en['chat.input.ariaLabel'] ?? '';
    expect(z.length).toBeGreaterThan(0);
    expect(e.length).toBeGreaterThan(0);
    expect(z).not.toBe('chat.input.ariaLabel');
    expect(e).not.toBe('chat.input.ariaLabel');
  });

  it('aria-label 与 placeholder 不是同一句（placeholder 是操作说明、一打字就消失）', async () => {
    const zh = (await loadZhChat()).chat;
    // 钉住**字面值**而不是 key 之间的关系：只比两个 key 的话，把两个值改成同一句
    // 仍会绿（W9310 变异 M9 实测）。placeholder 是会随状态变的操作说明
    // （idle/touch/steer/queue/worker 共 5 句），可访问名必须是稳定的「这是什么」一句话。
    expect(zh['chat.input.placeholderIdle']).toBe('输入消息，Enter 发送，Shift+Enter 换行');
    expect(zh['chat.input.ariaLabel']).toBe('消息输入框');
    expect(zh['chat.input.ariaLabel']).not.toBe(zh['chat.input.placeholderIdle']);
  });

  it('applyI18n 真的把 aria-label 写到 DOM 上', async () => {
    setBody(
      '<textarea id="input" data-i18n-placeholder="chat.input.placeholderIdle" ' +
        'data-i18n-aria-label="chat.input.ariaLabel"></textarea>',
    );
    const dom = await loadI18nDom();
    dom.applyI18n(doc);
    const ta = el('input');
    expect(ta.getAttribute('aria-label')).toBeTruthy();
    expect(ta.getAttribute('aria-label')).not.toBe('chat.input.ariaLabel');
  });
});
