// @vitest-environment jsdom
/**
 * F2-06 / F2-07：语义边框对比度 + 移动端抽屉的背景焦点隔离。
 *
 * F2-06：--c-border-strong 对 --c-surface 只有 1.98:1（浅）/ 2.47:1（深），够画装饰
 *        分隔线，但**不满足** WCAG 1.4.11 非文本 3:1。绝大多数用法确实是装饰，
 *        不该动；但有两处承担语义（inbox 气泡＝「这不是用户说的话」、引用块左竖线
 *        ＝「这是引用」），这两处改用新加的 --c-border-semantic（18.88 / 14.56）。
 *        本文件钉住「**只有该用语义档位的用语义档位**」，而不是全站改色。
 * F2-07：移动端抽屉是覆盖式 + 遮罩（事实上的模态），但背景仍可聚焦：
 *        390x844 实测 Tab×10 有 9 次落进被遮罩盖住的主区控件。改用与设置页
 *        同一个原生 inert 内核（utils/modal-bg.ts），并成对摘除。
 *
 * 加载纪律（同前两个文件）：
 *   1. 前端模块走 at(rel) 动态加载器 + 窄接口，不得写 typeof import(...)；
 *   2. 不得用 DOM 全局类型（根 tsconfig 的 lib 里没有 DOM），经夹具 doc / ElLike 访问。
 */
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { at, doc, type ElLike } from './lib/w795-dom.js';

/**
 * 仓库根：从本文件位置反推，**不得写死本机绝对路径**。
 * 写死只在作者本机成立 —— CI runner 上必然 ENOENT（main run 37133961564 即因此变红），
 * 而本地因为那个路径真实存在反而全绿，属「把本机事实当普遍事实」（同 17cacfc 那一类）。
 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STYLES = ROOT + '/apps/web/src/styles/';

interface FocusEl extends ElLike {
  hasAttribute(k: string): boolean;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  focus(): void;
  querySelector(sel: string): FocusEl | null;
  classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): boolean; contains(c: string): boolean };
}


/** 读一条 CSS 规则块的选择器与声明体（纯文本解析，够用且不依赖 jsdom 的 CSSOM）。 */
function blockOf(file: string, marker: string): string {
  const css = readFileSync(STYLES + file, 'utf8');
  const at = css.indexOf(marker);
  if (at < 0) throw new Error('未找到规则：' + file + ' ← ' + marker);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('F2-06 · 承担语义的边框用语义档位', () => {
  it('tokens.css 提供 --c-border-semantic，且指向最高一档 border-l4', () => {
    const css = readFileSync(STYLES + 'tokens.css', 'utf8');
    expect(css).toContain('--c-border-semantic: var(--border-l4);');
  });

  it('语义档位与 strong 档位是**两个** token（没有把 strong 整体换掉）', () => {
    const css = readFileSync(STYLES + 'tokens.css', 'utf8');
    expect(css).toContain('--c-border-strong: var(--border-l3);');
    expect(css).toContain('--c-border-semantic:');
  });

  it('inbox 气泡描边用语义档位 —— 它是「这不是用户说的话」的唯一视觉标记', () => {
    const body = blockOf('views.css', '.msg.inbox .bubble.inbox-bubble');
    expect(body).toContain('var(--c-border-semantic)');
    expect(body).not.toContain('var(--c-border-strong)');
  });

  it('引用块左竖线用语义档位', () => {
    const body = blockOf('components.css', '.rendered blockquote');
    expect(body).toContain('border-left: 2px solid var(--c-border-semantic)');
    expect(body).not.toContain('var(--c-border-strong)');
  });

  it('纯装饰处仍用 strong —— 不许全站改色（那会毁掉层次）', () => {
    const css = readFileSync(STYLES + 'components.css', 'utf8');
    const decor = (css.match(/var\(--c-border-strong\)/g) ?? []).length;
    expect(decor).toBeGreaterThan(0);
  });

  it('样式门禁口径：本次改的三个文件没有「圆角 + 硬编码 px」', () => {
    const bad: string[] = [];
    for (const f of ['tokens.css', 'views.css', 'components.css']) {
      const text = readFileSync(STYLES + f, 'utf8');
      for (const m of text.matchAll(/border-radius\s*:\s*([^;]+);/g)) {
        const v = (m[1] ?? '').trim();
        if (/\d+px/.test(v) && !v.includes('999px')) bad.push(f + ' ' + v);
      }
    }
    expect(bad).toEqual([]);
  });
});
/**
 * 与 index.html **同构**的骨架（F2-07-01 修的就是这里）。
 *
 * 修复前的夹具把 #sidebar / #sidebarScrim / #main 直接挂在 #app 下面，而真实 DOM 是
 *   #app > [ #topbar, #layout ]，#layout > [ #sidebar, #sidebarResizer, #sidebarScrim, #main ]
 * （真机 390x844 CDP 实测，results/audit4/F2/probe-E.json 的 E0_ancestry）。
 * 夹具一旦把 #sidebarScrim 摆成 #sidebar 的同级兄弟，它就恰好落在
 * isolateBackground 的「兄弟子树 = 背景」射程内 —— 而这正是真机上发生的事，
 * 夹具却让人误以为「scrim 是浮层自己的、不在射程内」。真实结构必须写出来。
 */
const APP_HTML =
  '<div id="app">' +
  '<header id="topbar"><button id="btnSidebar">x</button></header>' +
  '<div id="layout">' +
  '<aside id="sidebar"><button id="sessA">A</button></aside>' +
  '<div id="sidebarResizer" class="sidebar-resizer"></div>' +
  '<div id="sidebarScrim" class="sidebar-scrim hidden"></div>' +
  '<main id="main">' +
  '<div id="statusline" class="statusline"></div>' +
  '<button id="bgBtn">bg</button><textarea id="input"></textarea>' +
  '</main>' +
  '</div>' +
  '</div>';

/** jsdom 里 window.matchMedia 不存在；抽屉靠它判档 + 监听断点变化，这里打桩。 */
function stubViewport(isMobile: boolean): { setMobile(v: boolean): void } {
  let mobile = isMobile;
  const listeners: Array<(e: { matches: boolean }) => void> = [];
  const mql = {
    get matches() {
      return mobile;
    },
    addEventListener: (_t: string, f: (e: { matches: boolean }) => void) => listeners.push(f),
  };
  (globalThis as unknown as { window: Record<string, unknown> }).window.matchMedia = () => mql;
  return {
    setMobile(v: boolean) {
      mobile = v;
      for (const f of listeners) f({ matches: v });
    },
  };
}

interface SidebarMod {
  initSidebar(): void;
}

const loadSidebar = async (): Promise<SidebarMod> =>
  (await import(/* @vite-ignore */ at('ui/sidebar.ts'))) as unknown as SidebarMod;

const el = (id: string): FocusEl => doc.getElementById(id) as unknown as FocusEl;

const click = (id: string): void => {
  const E = (globalThis as unknown as { Event: new (t: string) => unknown }).Event;
  el(id).dispatchEvent(new E('click'));
};

describe('F2-07 · 移动端抽屉的背景焦点隔离', () => {
  let vp: { setMobile(v: boolean): void };

  beforeEach(() => {
    (doc as unknown as { body: ElLike }).body.innerHTML = APP_HTML;
    vp = stubViewport(true);
  });

  afterEach(() => {
    (doc as unknown as { body: ElLike }).body.innerHTML = '';
  });

  it('抽屉打开时：主区 inert（状态行随之不可聚焦），抽屉自身不 inert', async () => {
    const mod = await loadSidebar();
    mod.initSidebar();
    click('btnSidebar');
    expect(el('app').classList.contains('drawer-open')).toBe(true);
    expect(el('main').hasAttribute('inert')).toBe(true);
    expect(el('sidebar').hasAttribute('inert')).toBe(false);
    // 状态行在真实 DOM 里是 #main 的**后代**（不是 #sidebar 的兄弟），所以它自己身上
    // 没有 inert 属性、而是被祖先罩住。断言「被 inert 祖先罩住」而不是「自己带 inert」。
    expect(el('statusline').hasAttribute('inert')).toBe(false);
    expect(el('statusline').closest('[inert]')?.id).toBe('main');
  });

  it('点遮罩关闭后：inert 一定摘干净（漏摘等于整站变砖）', async () => {
    const mod = await loadSidebar();
    mod.initSidebar();
    click('btnSidebar');
    click('sidebarScrim');
    expect(el('main').hasAttribute('inert')).toBe(false);
    expect(el('statusline').hasAttribute('inert')).toBe(false);
    expect(el('sidebar').hasAttribute('inert')).toBe(false);
  });

  it('Esc 关闭同样摘干净', async () => {
    const mod = await loadSidebar();
    mod.initSidebar();
    click('btnSidebar');
    const KE = (globalThis as unknown as { KeyboardEvent: new (t: string, i?: object) => unknown })
      .KeyboardEvent;
    (doc as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(
      new KE('keydown', { key: 'Escape' }),
    );
    expect(el('app').classList.contains('drawer-open')).toBe(false);
    expect(el('main').hasAttribute('inert')).toBe(false);
  });

  // ---- F2-07-01：遮罩是抽屉自己的关闭控件，不是背景 -------------------------
  //
  // 回归本身：isolateBackground 的口径是「keep 的兄弟子树 = 背景」，而 #sidebarScrim
  // 与 #sidebar 同为 #layout 的子节点，正好落在射程内。inert 的元素不参与命中测试，
  // 于是 initDrawer 里那条 scrim 的 click 监听永远收不到事件 —— 真机 390x844 对照
  // 实验（results/audit4/F2/probe-F.json）：带 inert 时点遮罩区 elementFromPoint 落到
  // #layout、drawer 保持 true；仅摘掉遮罩的 inert 后点同一坐标即命中 #sidebarScrim。
  //
  // ★ 为什么下面第一条断言的是**属性**而不是「点一下没反应」：
  //   jsdom 根本没实现 inert 的命中测试语义 —— dispatchEvent 照样会派发给带 inert 的
  //   元素。所以「点遮罩关抽屉」这个用例在 jsdom 里**恒绿**，抓不到本 bug。
  //   真正的因果是「遮罩身上有没有 inert」，那条才是承重断言。
  it('遮罩不被置 inert —— 置了它就点不中（抽屉的主关闭手势失效）', async () => {
    const mod = await loadSidebar();
    mod.initSidebar();
    click('btnSidebar');
    // 背景照样被隔离：这条不能因为修了遮罩就一起放跑。
    expect(el('main').hasAttribute('inert')).toBe(true);
    expect(el('sidebarResizer').hasAttribute('inert')).toBe(true);
    // 承重断言：遮罩必须留在命中测试里。
    expect(el('sidebarScrim').hasAttribute('inert')).toBe(false);
  });

  it('点遮罩仍能关抽屉（监听没被摘掉）', async () => {
    const mod = await loadSidebar();
    mod.initSidebar();
    click('btnSidebar');
    click('sidebarScrim');
    expect(el('app').classList.contains('drawer-open')).toBe(false);
  });

  it('exclude 的节点不进句柄 ⇒ restore 不会误摘别人设的 inert', async () => {
    const mod = await loadSidebar();
    // 别的层（例如设置页的 isolateBackground 把整个 #app 罩住时）给遮罩加过 inert，
    // 抽屉关掉后**不能**替它摘 —— restore 只遍历本次由我们改的 nodes。
    el('sidebarScrim').setAttribute('inert', '');
    mod.initSidebar();
    click('btnSidebar');
    click('sidebarScrim');
    expect(el('sidebarScrim').hasAttribute('inert')).toBe(true);
    expect(el('main').hasAttribute('inert')).toBe(false);
  });
  it('桌面档点汉堡不隔离 —— 抽屉不是桌面语义', async () => {
    vp.setMobile(false);
    const mod = await loadSidebar();
    mod.initSidebar();
    click('btnSidebar');
    expect(el('main').hasAttribute('inert')).toBe(false);
  });
});
