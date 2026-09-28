// @vitest-environment jsdom
// ============================================================================
// W2057 验收：点正文外链 ⇒ **工作台浏览器面板**（而不是新标签页）。
//
// 用户原话：「打开网页链接应该自动打开我们提供的浏览器而非新建页面。」
//
// 本文件守六件事，每件对应一条**变异负控制**（原文见报告 §5）：
//   ① 左键点正文 http(s) 外链 ⇒ 浏览器面板打开、且 panel.data.url === 该 href；
//   ② **复用**已有浏览器面板（点第 2 个链接不新开第 2 个面板）；
//   ③ #fragment / mailto: / tel: ⇒ **不**开面板、**不** preventDefault；
//   ④ Ctrl/Cmd/Shift/Alt + 左键、以及中键 ⇒ **不**走面板（用户的显式意图）；
//   ⑤ 键盘：Enter 走的是浏览器的**默认动作**（本模块不碰 keydown）⇒
//      ① 的拦截不会破坏它，且不存在 IME 问题；
//   ⑥ 出口常驻：浏览器面板的「在新标签打开」按钮**始终**存在（跨域被拒在父
//      页面侧不可判定 ⇒ 出口不能只在降级时出现）。
//
// ★ 与 apps/web/src/utils/link-target.test.ts（W2051）的分工：
//   那个文件守**属性面**（sanitize 落定的 target/rel，W2051 的契约，本遍不改）；
//   本文件守**事件面**（点击之后去哪）。两者不是同一条断言的两种写法。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLinkOpen, shouldOpenInPanel } from './link-open';
import { openUrlInPanel } from './open-url';
import { listPanels, onPanelsChange, panelOf, resetPanels } from './state';

/** 造一个正文锚点并挂进文档（模拟 markdown 渲染产物）。 */
function anchor(href: string, text = 'x'): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  return a;
}

/** 派发一次可取消的 click；返回事件本身（用来读 defaultPrevented）。 */
function clickOn(el: Element, init: MouseEventInit = {}): MouseEvent {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(ev);
  return ev;
}

/** 浏览器面板的 url 列表（按打开顺序）。 */
function browserUrls(): string[] {
  return listPanels()
    .filter((p) => p.kind === 'browser')
    .map((p) => String((p.data as { url?: string } | undefined)?.url ?? ''));
}

let opened: string[] = [];

beforeEach(() => {
  resetPanels();
  document.body.replaceChildren();
  installLinkOpen();
  opened = [];
  vi.stubGlobal('open', (...args: unknown[]) => { opened.push(String(args[0])); return null; });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  resetPanels();
});

describe('W2057 · 点正文外链 ⇒ 浏览器面板', () => {
  it('① 左键点 http(s) 外链 ⇒ 面板打开、url 正确、且默认行为被拦', () => {
    const a = anchor('https://example.com/probe');
    const ev = clickOn(a);
    expect(browserUrls()).toEqual(['https://example.com/probe']);
    expect(ev.defaultPrevented, '必须拦掉「新标签页」').toBe(true);
    expect(opened, '本模块自己不该调 window.open').toEqual([]);
  });

  it('① ★ 首次点击就要**真的导航**（不是开一个空面板）—— 真机抓到的顺序缺陷', () => {
    // 缺陷原文（CDP 审计，报告 §6）：openPanel() 内部是**先 emit 再 return**，
    // 所以「新建面板」那一帧渲染层跑的时候 panel.data 还没写 ⇒ current === ''
    // ⇒ 面板开出来是**空的**，要点第二次（走复用路径）才导航。
    // 断言方式必须是「渲染层**收到通知时**读到的 url」—— 只看 panel.data.url
    // 是看不见这个缺陷的（它确实写对了）。
    const seenAtNotify: (string | undefined)[] = [];
    const off = onPanelsChange(() => {
      const p = listPanels().find((x) => x.kind === 'browser');
      seenAtNotify.push((p?.data as { url?: string } | undefined)?.url);
    });
    openUrlInPanel('https://first.example/1');
    off();
    expect(seenAtNotify.length, '至少要通知一次').toBeGreaterThan(0);
    // 每一次通知时渲染层都必须已经能看到 url（否则它会渲染出一个不导航的面板）。
    for (const u of seenAtNotify) expect(u, '通知时 data.url 必须已就位').toBe('https://first.example/1');
  });

  it('① 点在锚点的**子元素**上也命中（markdown 的 [x](url) 渲染成 <a><code>）', () => {
    const a = anchor('https://example.com/deep');
    const code = document.createElement('code');
    code.textContent = 'x';
    a.replaceChildren(code);
    clickOn(code);
    expect(browserUrls()).toEqual(['https://example.com/deep']);
  });

  it('② 已有浏览器面板 ⇒ **复用**（点 3 个链接只有 1 个面板，url 是最后那个）', () => {
    clickOn(anchor('https://a.example/1'));
    clickOn(anchor('https://b.example/2'));
    clickOn(anchor('https://c.example/3'));
    expect(listPanels().filter((p) => p.kind === 'browser'), '复用：不新开').toHaveLength(1);
    expect(browserUrls()).toEqual(['https://c.example/3']);
  });

  it('② 复用路径**必须通知渲染层**（否则面板不会导航 —— 只改 data 是看不见的）', () => {
    // ★ 这条断言为什么订阅 onPanelsChange 而不是只读 panel.data：
    //   渲染层（panel.ts 的 renderWorkbench）是**订阅者**，只在收到通知时重画。
    //   复用路径上没有任何增删，state 不会自己 emit ⇒「忘了 notify」这个缺陷在
    //   「只读 data」的断言下**完全不可见**（本遍变异 M7 实测就是这么漏的：
    //   第一版测试是绿的，等于没牙）。
    const p1 = openUrlInPanel('https://a.example/1');
    let fired = 0;
    const off = onPanelsChange(() => { fired += 1; });
    openUrlInPanel('https://b.example/2');
    off();
    expect(fired, '复用必须 emit 一次（渲染层据此导航）').toBe(1);
    expect(listPanels().length, '第二次不新开面板').toBe(1);
    expect(panelOf(p1.id)?.data?.['url']).toBe('https://b.example/2');
  });

  it('③ #fragment / mailto: / tel: ⇒ **不**开面板、**不**拦默认行为', () => {
    for (const href of ['#section-1', 'mailto:a@b.c', 'tel:+8613800000000']) {
      resetPanels();
      const ev = clickOn(anchor(href));
      expect(browserUrls(), href).toEqual([]);
      expect(ev.defaultPrevented, href + ' 必须留给浏览器').toBe(false);
    }
  });

  it('④ Ctrl / Cmd / Shift / Alt + 左键 ⇒ 不进面板（用户显式要新标签页）', () => {
    for (const mod of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const) {
      resetPanels();
      const ev = clickOn(anchor('https://example.com/m'), { [mod]: true });
      expect(browserUrls(), mod).toEqual([]);
      expect(ev.defaultPrevented, mod + ' 不该被拦').toBe(false);
    }
  });

  it('④ 中键（button=1）⇒ 不进面板', () => {
    const ev = clickOn(anchor('https://example.com/mid'), { button: 1 });
    expect(browserUrls()).toEqual([]);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('④ 非锚点、以及没有 href 的 <a> ⇒ 完全不碰', () => {
    const p = document.createElement('p');
    p.textContent = '纯文本';
    document.body.appendChild(p);
    const ev = clickOn(p);
    expect(browserUrls()).toEqual([]);
    expect(ev.defaultPrevented).toBe(false);
    const bare = document.createElement('a');
    bare.textContent = 'no href';
    document.body.appendChild(bare);
    clickOn(bare);
    expect(browserUrls()).toEqual([]);
  });

  it('⑤ 键盘：Enter 的默认动作 = 一条可取消的 click ⇒ 走**同一个**出口', () => {
    const a = anchor('https://example.com/kbd');
    const ev = clickOn(a);
    expect(browserUrls()).toEqual(['https://example.com/kbd']);
    expect(ev.defaultPrevented).toBe(true);
    // 反证：本模块**没有**挂 keydown。没有 click 就没有面板，也没有 preventDefault。
    resetPanels();
    const kev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    a.dispatchEvent(kev);
    expect(browserUrls(), 'keydown 不产生面板（浏览器负责把它变成 click）').toEqual([]);
    expect(kev.defaultPrevented).toBe(false);
  });

  it('⑥ 出口常驻，且**住在 URL 行里**（不是排在 iframe 之后）', async () => {
    const body = document.createElement('div');
    document.body.appendChild(body);
    const mod = await import('./browser');
    const panel = { id: 'wbX', kind: 'browser' as const, title: 'B', dock: 'right' as const, size: 420, seq: 0 };
    mod.renderBrowserPanel(body, panel, () => true);
    const ext = body.querySelector('.wb-url-external');
    expect(ext, '出口必须存在').not.toBeNull();
    expect(ext?.classList.contains('hidden'), '出口不随降级显隐').toBe(false);
    // ★ 结构不变量：出口必须是 .wb-url-row 的子节点，**不能**排在 .wb-frame 之后。
    //   真机截图抓到的布局缺陷：.wb-frame 的高度是 calc(100% - 34px)，任何排在它
    //   **后面**的兄弟都会被推出可视区（要滚动才看得到）—— 出口的全部意义就是
    //   「被拒时用户仍有路走」，看不见等于没有。
    //   jsdom 不做布局 ⇒ 量不到「被挤出屏幕」；能机械钉住的是**导致它的结构**
    //   （DOM 次序 + CSS 高度算式），所以这条断言钉结构、真机截图钉观感。
    expect(ext?.parentElement?.classList.contains('wb-url-row'), '出口必须住在 URL 行里').toBe(true);
    const frame = body.querySelector('.wb-frame');
    expect(frame, 'iframe 仍在').not.toBeNull();
    // 出口在 frame **之前**（文档序）：frame 之后的位置就是会被挤出去的那个。
    const order = Array.from(body.querySelectorAll('.wb-url-external, .wb-frame'));
    expect(order[0]?.classList.contains('wb-url-external'), '出口必须先于 iframe 出现').toBe(true);
  });
});

describe('W2057 · shouldOpenInPanel 判定（纯函数）', () => {
  it('只有绝对 http(s) 进面板', () => {
    expect(shouldOpenInPanel('https://e.com')).toBe(true);
    expect(shouldOpenInPanel('HTTPS://E.COM')).toBe(true);
    expect(shouldOpenInPanel('http://e.com')).toBe(true);
    expect(shouldOpenInPanel('mailto:a@b.c')).toBe(false);
    expect(shouldOpenInPanel('tel:+1')).toBe(false);
    expect(shouldOpenInPanel('#a')).toBe(false);
    expect(shouldOpenInPanel('')).toBe(false);
    expect(shouldOpenInPanel(null)).toBe(false);
  });

  it('相对路径 / 协议相对 ⇒ **不**进面板（面板补不出正确的绝对地址）', () => {
    expect(shouldOpenInPanel('./README.md')).toBe(false);
    expect(shouldOpenInPanel('/docs/a.md')).toBe(false);
    expect(shouldOpenInPanel('//example.com/p')).toBe(false);
  });

  it('③ 只有 http(s) 的**绝对** URL 进面板：两段判定的交集', () => {
    // ★ 诚实登记（本遍变异 M5 实测）：把「复用 linkOpensInNewTab」那一段删掉，
    //   测试**不会红** —— 因为第二段 /^https?:/ 已经蕴含了它（对 #fragment /
    //   mailto / tel / 相对路径一律 false）。所以那一段是**声明意图 + 防未来分叉**，
    //   不是当前唯一的闸门。这是一个**等价变异体**，不是测试缺口；
    //   真正的闸门由下面这条钉住（把任何一段改宽都会红）。
    for (const bad of ['#frag', 'mailto:a@b.c', 'tel:+1', './x.md', '/x.md', '//h/p', 'ftp://h/p', 'file:///etc/passwd']) {
      expect(shouldOpenInPanel(bad), bad).toBe(false);
    }
  });

  it('危险 scheme 即使在 href 上也不进面板（与 safeUrl 同口径：先剥控制字符）', () => {
    expect(shouldOpenInPanel('javascript:alert(1)')).toBe(false);
    expect(shouldOpenInPanel('java\tscript:alert(1)')).toBe(false);
    expect(shouldOpenInPanel('data:text/html,<b>x</b>')).toBe(false);
    expect(shouldOpenInPanel('\t#frag')).toBe(false);
  });
});