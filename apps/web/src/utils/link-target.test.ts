// @vitest-environment jsdom
// ============================================================================
// W2051 验收：正文里 markdown 链接的**打开方式**（缺陷：点链接会离开应用）。
//
// 缺陷原文（真机 CDP，隔离实例 3811，干净 HEAD 的 dist）：
//   ANCHORS[0] = { hrefAttr: "https://example.com/probe", target: null, rel: null,
//                  cursor: "pointer", tabIndex: 0 }          ← 看起来可点、无任何 target
//   URL_BEFORE  = "http://127.0.0.1:3811/"
//   URL_AFTER   = "https://example.com/probe"                 ← ★ 当前标签页被导航走
//   FRAME_NAVIGATED = [{ url: "https://example.com/probe", parentId: null }]
//   APP_STILL_HERE  = { hasChat: false, bodyHead: "Example Domain…" }
//   ⇒ 用户点正文里的链接 ⇒ 离开 Studio、丢掉当前会话视图。
//
// 本文件守五件事，每件对应一条**变异负控制**（见报告）：
//   ① 会离开文档的 href ⇒ target=_blank + rel="noopener noreferrer"（去掉 target/rel 必红）；
//   ② 危险 scheme **仍被剔除**（去掉 safeUrl 的 scheme 校验必红）；
//   ③ 同文档片段 / mailto / tel **不**加 target（加了就是「跳到标题」变「重开应用」）；
//   ④ 不可信 HTML 自带的 target/rel 被**覆盖**而不是被信任（去掉改写必红）；
//   ⑤ 键盘：Enter 由浏览器对 <a href> 原生处理，本遍**不碰** keydown
//      ⇒ 没有任何 preventDefault 能挡掉它（去掉 href 必红）。
//
// ★ 为什么断言落在 sanitize 出口而不是「点击后 window.open 被调用」：
//   本方案**刻意不加事件委托**（见 utils/link-target.ts 头注：消毒期才覆盖全部
//   进 DOM 的路径）。真机证据是「点击产生新 page target 且当前页 URL 不变」，
//   而「新标签页」这件事在 jsdom 里无法真实发生 —— 所以 jsdom 侧钉的是**行为
//   契约**（属性），真机侧钉的是**结果**（CDP 的 target/导航事件，见报告 §6）。
//   两者不是同一条断言的两种写法，而是各自测各自能测的那一半。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { sanitizeHtml, sanitizeNodes } from './sanitize';
import { LINK_REL, LINK_TARGET, linkOpensInNewTab } from './link-target';

/** 取第一个 <a> 的属性快照（走真实消毒出口）。 */
function anchorAttrs(html: string): Record<string, string | null> {
  const host = document.createElement('div');
  host.replaceChildren(...sanitizeNodes(html));
  const a = host.querySelector('a');
  if (a === null) throw new Error('no <a> in ' + html);
  return { href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') };
}

describe('W2051 · 会离开文档的链接 ⇒ 新标签页', () => {
  /** 逐字段断言（失败信息看得出是 href/target/rel 哪一个不对）。 */
  function expectOut(src: string, href: string): void {
    const attrs = anchorAttrs(src);
    expect(attrs.href, src).toBe(href);
    expect(attrs.target, src).toBe(LINK_TARGET);
    expect(attrs.rel, src).toBe(LINK_REL);
  }

  it('① 绝对 http(s) 链接：target=_blank + rel=noopener noreferrer', () => {
    expectOut('<a href="https://example.com/probe">x</a>', 'https://example.com/probe');
    expectOut('<a href="http://example.com/probe">x</a>', 'http://example.com/probe');
  });

  it('① 相对路径与协议相对 URL 也是真实导航 ⇒ 同样新标签页', () => {
    // 本应用没有任何客户端路由（全仓 pushState/popstate/hashchange 命中 0）⇒
    // 相对路径会把 SPA 整个换掉，与绝对 URL 同类。
    expectOut('<a href="./README.md">x</a>', './README.md');
    expectOut('<a href="/docs/a.md">x</a>', '/docs/a.md');
    expectOut('<a href="//example.com/p">x</a>', '//example.com/p');
  });

  it('③ 同文档片段 #heading：**不**加 target（本仓刻意保留标题 id 供会话内定位）', () => {
    expect(anchorAttrs('<a href="#section-1">x</a>')).toEqual({ href: '#section-1', target: null, rel: null });
    // 空 href 是「回到文档顶部」的自引用，同样不离开文档。
    expect(anchorAttrs('<a href="">x</a>')).toEqual({ href: null, target: null, rel: null });
  });

  it('③ mailto: / tel:：交给外部协议处理器，应用留在原地 ⇒ **不**加 target', () => {
    // 真机实测依据：无 target 时点击 mailto 不产生任何新 target、页面不导航；
    // 加 target=_blank 会留下一个空白标签页（实测产生 url:"" 的新 page target）。
    expect(anchorAttrs('<a href="mailto:a@b.c">x</a>')).toEqual({ href: 'mailto:a@b.c', target: null, rel: null });
    expect(anchorAttrs('<a href="tel:+8613800000000">x</a>')).toEqual({ href: 'tel:+8613800000000', target: null, rel: null });
  });

  it('② 危险 scheme 仍被剔除（回归：safeUrl 一字未放宽）', () => {
    // 每条的判据都是「href 没了」⇒ 它同时证明「没有被加上 target」。
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<b>x</b>',
      'vbscript:msgbox(1)',
      'blob:https://example.com/uuid',
      'file:///etc/passwd',
    ]) {
      const attrs = anchorAttrs('<a href="' + bad + '">x</a>');
      expect(attrs, bad).toEqual({ href: null, target: null, rel: null });
      expect(sanitizeHtml('<a href="' + bad + '">x</a>')).not.toContain('target=');
    }
  });

  it('④ 不可信 HTML 自带的 target/rel 被**覆盖**，不是被信任', () => {
    // 这是本方案唯一的新攻击面：target/rel 进了 TAG_ATTRS 才可能被原文写进来。
    // 出口只允许两种形态 —— 被 safeUrl 剔除（全 null），或改写成本仓的值。
    // 逐字段断言（而不是整对象 toEqual）：失败信息才看得出**哪个**属性被信任了。
    for (const src of [
      '<a href="https://e.com/x" target="_self" rel="opener">x</a>',
      '<a href="https://e.com/x" target="_top">x</a>',
      '<a href="https://e.com/x" rel="opener">x</a>',
    ]) {
      const attrs = anchorAttrs(src);
      expect(attrs.href, src).toBe('https://e.com/x');
      expect(attrs.target, src).toBe(LINK_TARGET);
      expect(attrs.rel, src).toBe(LINK_REL);
    }
    // 危险 scheme + 自带 target：两个属性都必须消失（不是只删 href 留下 target）。
    expect(anchorAttrs('<a href="javascript:alert(1)" target="_blank" rel="noopener">x</a>')).toEqual({ href: null, target: null, rel: null });
    // 没有 href 的 <a> 也不该带 target/rel。
    expect(anchorAttrs('<a target="_blank" rel="noopener">x</a>')).toEqual({ href: null, target: null, rel: null });
  });

  it('⑤ 键盘可达性不被破坏：href 原样保留、本遍不挂任何事件处理器', () => {
    // <a href> 原生就键盘可达（Tab + Enter），Enter 走的是浏览器的**默认动作**，
    // 不是某个 keydown 监听 —— 所以「不加拦截」正是键盘能继续工作的原因。
    // 反过来说：只要 href 还在、且没有任何 preventDefault，Enter 就一定触发。
    const host = document.createElement('div');
    host.replaceChildren(...sanitizeNodes('<p>看 <a href="https://example.com/k">这个</a></p>'));
    document.body.appendChild(host);
    const a = host.querySelector('a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://example.com/k');
    expect(a.tabIndex).toBe(0); // 原生可聚焦（未被人为改成 -1）
    // 默认动作没有被任何监听挡掉：派发一次可取消的 keydown，defaultPrevented 必须为 false。
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    // 本遍零监听：<a> 上不应出现任何 onclick（on* 属性一律被消毒剔除）。
    expect(a.getAttribute('onclick')).toBeNull();
    expect(sanitizeHtml('<a href="https://e.com" onclick="alert(1)">x</a>')).not.toContain('onclick');
    host.remove();
  });

  it('幂等：流式每节拍重跑消毒，属性不叠加、不漂移', () => {
    // 流式渲染每个 tick 都会重跑整条链（marked → sanitize → DOM），所以同一条
    // markdown 被消毒多次的结果必须逐字相同（不像「追加属性」的写法会累加）。
    const once = sanitizeHtml('<a href="https://e.com/x">x</a>');
    expect(sanitizeHtml(once)).toBe(once);
    expect(sanitizeHtml(sanitizeHtml(once))).toBe(once);
    // 已经带本仓 target/rel 的产物再过一遍，也不产生 rel="noopener noreferrer noopener…"。
    expect(once.match(/noopener/g)).toHaveLength(1);
  });
});

describe('W2051 · linkOpensInNewTab 判定（纯函数，零 DOM）', () => {
  it('判定与 safeUrl 同一把尺子：先剥控制字符与空白再判 scheme', () => {
    // 若这里不剥，'\t#x' 会被当成相对路径 ⇒ 与 safeUrl 的判定分叉。
    expect(linkOpensInNewTab('\t#frag')).toBe(false);
    expect(linkOpensInNewTab('  https://e.com  ')).toBe(true);
    expect(linkOpensInNewTab('\u0000')).toBe(false);
  });

  it('出口是二值的：只有 http/https 走新标签页，其余 scheme 一律留在原地', () => {
    expect(linkOpensInNewTab('https://e.com')).toBe(true);
    expect(linkOpensInNewTab('HTTPS://E.COM')).toBe(true);
    expect(linkOpensInNewTab('mailto:a@b.c')).toBe(false);
    expect(linkOpensInNewTab('tel:+1')).toBe(false);
    expect(linkOpensInNewTab('#a')).toBe(false);
  });
});
