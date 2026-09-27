// @vitest-environment jsdom
// ============================================================================
// W2025 验收：正文里可点路径的**键盘等效路径**（W2013 只做了 click 委托）。
//
// 本文件守五件事，每件都对应一条**变异负控制**（见报告）：
//   ① 可点路径**能被键盘聚焦** —— 去掉 tabindex 必红；
//   ② 聚焦后 **Enter / Space** 打开预览 —— 去掉 keydown 处理必红；
//   ③ **Tab 序列不被污染** —— 不可点路径不进入序列、一条消息只多 1 个停靠点；
//   ④ **鼠标行为一字不变** —— defaultPrevented 与打开结果与 W2013 逐条一致；
//   ⑤ pre > code（代码块）键盘侧同样排除。
//
// ★ 与 file-link.test.ts 的分工：那个文件守 W2013 的既有契约（12 例，不许破）；
//   本文件只加键盘通道的断言。两者共用同一套依赖替换与流式复刻。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileLinkEnhancer } from './file-link';
import { registerEnhancer, runEnhancers } from './registry';

const h = vi.hoisted(() => ({ opened: [] as string[], wsRoot: '/ws' }));
vi.mock('../workbench/files-open', () => ({
  openFilePreview: (abs: string) => { h.opened.push(abs); },
}));
vi.mock('../commands/files', () => ({
  workspacePath: () => h.wsRoot,
}));

/** 复刻 ui/messages/assistant.ts:103-108（流式：增强跑在**临时 div** 上）。 */
function runEnhancersOnFragment(frag: DocumentFragment): void {
  const scope = document.createElement('div');
  while (frag.firstChild !== null) scope.appendChild(frag.firstChild);
  runEnhancers(scope);
  while (scope.firstChild !== null) frag.appendChild(scope.firstChild);
}

/** 造一条消息正文（class 与 user.ts:66 / assistant.ts:365 一致）。 */
function contentWith(html: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'content rendered';
  box.innerHTML = html;
  document.body.appendChild(box);
  return box;
}

/** 走**真实流式路径**：新节点在 fragment 里跑增强，再整体插进正文。 */
function streamInto(box: HTMLElement, html: string): void {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const frag = document.createDocumentFragment();
  while (tpl.content.firstChild !== null) frag.appendChild(tpl.content.firstChild);
  runEnhancersOnFragment(frag);
  box.appendChild(frag);
}

/** MutationObserver 是微任务 ⇒ 等一拍（真机上是同一帧之后）。 */
const tick = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

/** 在元素上派发一次可取消的点击，返回事件（看 defaultPrevented）。 */
function clickOn(el: Element): MouseEvent {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

/** 在元素上派发一次可取消的 keydown，返回事件（看 defaultPrevented）。 */
function keyOn(el: Element, key: string): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

/** 正文里所有命中节点（本遍的可点路径）。 */
function hitsIn(box: Element): Element[] {
  return Array.from(box.querySelectorAll('[data-fl-hit="1"]'));
}

/** 正文里当前**进 Tab 序列**的命中节点。 */
function stopsIn(box: Element): Element[] {
  return Array.from(box.querySelectorAll('[data-fl-hit="1"][tabindex="0"]'));
}

let off: (() => void) | null = null;

beforeEach(() => {
  h.opened.length = 0;
  h.wsRoot = '/ws';
  document.body.replaceChildren();
  document.body.removeAttribute('data-file-link-done');
  off = registerEnhancer(fileLinkEnhancer());
});

afterEach(() => {
  off?.();
  off = null;
  document.body.replaceChildren();
});

describe('W2025 正文文件路径的键盘等效路径', () => {
  it('① 可点路径能被键盘聚焦（tabindex=0 + role=button + 可读名字）', () => {
    const box = contentWith('<p>见 <code>apps/web/src/main.ts</code></p>');
    runEnhancers(box);
    const code = box.querySelector('code') as HTMLElement;
    expect(code.getAttribute('tabindex')).toBe('0');
    expect(code.getAttribute('role')).toBe('button');
    // 4.1.2 的 name：自定义控件必须有可编程判定的名字。
    expect((code.getAttribute('title') ?? '').length).toBeGreaterThan(0);
    // ★ 真机同款判据：focus() 之后 document.activeElement 必须**就是它**。
    code.focus();
    expect(document.activeElement).toBe(code);
  });

  it('② 聚焦后按 Enter 打开预览（走与点击同一个出口）', () => {
    const box = contentWith('<p>见 <code>apps/web/src/main.ts</code></p>');
    runEnhancers(box);
    const code = box.querySelector('code') as HTMLElement;
    code.focus();
    expect(document.activeElement).toBe(code);
    const ev = keyOn(code, 'Enter');
    expect(h.opened).toEqual(['/ws/apps/web/src/main.ts']);
    expect(ev.defaultPrevented).toBe(true); // 真的接管了这次按键
  });

  it('②b 聚焦后按 Space 同样打开（且必须 preventDefault，否则页面滚一屏）', () => {
    const box = contentWith('<p>见 <code>apps/web/src/main.ts</code></p>');
    runEnhancers(box);
    const code = box.querySelector('code') as HTMLElement;
    code.focus();
    const ev = keyOn(code, ' ');
    expect(h.opened).toEqual(['/ws/apps/web/src/main.ts']);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('②c 「文件：x」句式（文本节点分支）也能聚焦并 Enter 打开', () => {
    const box = contentWith('<p>文件：src/ui/send.ts</p>');
    runEnhancers(box);
    const hit = hitsIn(box)[0] as HTMLElement;
    expect(hit).toBeDefined();
    hit.focus();
    expect(document.activeElement).toBe(hit);
    keyOn(hit, 'Enter');
    expect(h.opened).toEqual(['/ws/src/ui/send.ts']);
  });

  it('③ 不可点路径不进入 Tab 序列（裸词 / 无扩展名 / URL / 代码块）', () => {
    const box = contentWith(
      '<p>见 <code>src</code> 与 <code>README</code> 与 <code>https://example.com/a.ts</code></p>' +
      '<pre><code>a/b.ts</code></pre>',
    );
    runEnhancers(box);
    // 命中数为 0（没有任何一段被判成路径）。
    expect(hitsIn(box)).toEqual([]);
    // 正文里一个 tabindex 都没有 —— 没有污染 Tab 序列。
    expect(Array.from(box.querySelectorAll('[tabindex]'))).toEqual([]);
    // 键盘也不接管：Enter 打不开任何东西。
    for (const c of Array.from(box.querySelectorAll('code'))) {
      keyOn(c, 'Enter');
      clickOn(c);
    }
    expect(h.opened).toEqual([]);
  });

  it('④ Tab 序列长度与路径个数无关：一条消息 5 个路径 ⇒ 只多 1 个停靠点', () => {
    const box = contentWith(
      '<p>见 <code>a/1.ts</code>、<code>a/2.ts</code>、<code>a/3.ts</code>、' +
      '<code>a/4.ts</code>、<code>a/5.ts</code></p>',
    );
    runEnhancers(box);
    expect(hitsIn(box).length).toBe(5);          // 5 个都可点（鼠标语义不变）
    expect(stopsIn(box).length).toBe(1);         // 但 Tab 只多 1 个停靠点
    // 其余 4 个是 tabindex="-1"（可编程聚焦、不进序列）。
    expect(box.querySelectorAll('[data-fl-hit="1"][tabindex="-1"]').length).toBe(4);
  });

  it('④b 停靠点随焦点移交：Tab 能一路走完 5 个路径（不是只够得到第一个）', () => {
    const box = contentWith('<p><code>a/1.ts</code> <code>a/2.ts</code> <code>a/3.ts</code></p>');
    runEnhancers(box);
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const stop = stopsIn(box)[0] as HTMLElement;
      stop.focus();                       // focusin ⇒ 停靠点落到它身上
      seen.push(stop.textContent ?? '');
      keyOn(stop, 'Enter');
      stop.blur();                        // focusout ⇒ 交给下一个
    }
    expect(seen).toEqual(['a/1.ts', 'a/2.ts', 'a/3.ts']);
    expect(h.opened).toEqual(['/ws/a/1.ts', '/ws/a/2.ts', '/ws/a/3.ts']);
  });

  it('⑤ 鼠标行为一字不变：defaultPrevented 与打开结果与 W2013 逐条一致', () => {
    // (a) 行内 code 路径：接管 + 打开
    const box = contentWith('<p>见 <code>apps/web/src/main.ts</code></p>');
    runEnhancers(box);
    const evA = clickOn(box.querySelector('code') as Element);
    expect(h.opened).toEqual(['/ws/apps/web/src/main.ts']);
    expect(evA.defaultPrevented).toBe(true);
    // (b) 不可点：不接管、不打开
    h.opened.length = 0;
    const box2 = contentWith('<p>见 <code>README</code></p>');
    runEnhancers(box2);
    const evB = clickOn(box2.querySelector('code') as Element);
    expect(h.opened).toEqual([]);
    expect(evB.defaultPrevented).toBe(false);
    // (c) 锚点（锚点正文本身是合法路径）：放行给浏览器
    const box3 = contentWith('<p><a href="https://example.com/x"><code>docs/readme.md</code></a></p>');
    runEnhancers(box3);
    const evC = clickOn(box3.querySelector('a code') as Element);
    expect(h.opened).toEqual([]);
    expect(evC.defaultPrevented).toBe(false);
    // (d) 「文件：x」句式：点段落任意处仍然打开（切段没有改变鼠标落点语义）
    const box4 = contentWith('<p>文件：src/ui/send.ts</p>');
    runEnhancers(box4);
    const evD = clickOn(box4.querySelector('p') as Element);
    expect(h.opened).toEqual(['/ws/src/ui/send.ts']);
    expect(evD.defaultPrevented).toBe(true);
  });

  it('⑥ pre > code 键盘侧同样排除（既不进序列也不响应 Enter）', () => {
    const box = contentWith('<pre><code>a/b.ts</code></pre>');
    runEnhancers(box);
    expect(hitsIn(box)).toEqual([]);
    const code = box.querySelector('code') as HTMLElement;
    expect(code.hasAttribute('tabindex')).toBe(false);
    code.focus();
    expect(document.activeElement).not.toBe(code);
    keyOn(code, 'Enter');
    expect(h.opened).toEqual([]);
  });

  it('⑦ 关掉插件后键盘不再接管（注册表是唯一真源；监听还在 body 上）', () => {
    const box = contentWith('<p>见 <code>a/b.ts</code></p>');
    runEnhancers(box);
    const code = box.querySelector('code') as HTMLElement;
    code.focus();
    off?.(); // 真注销（＝设置页关开关）
    off = null;
    keyOn(code, 'Enter');
    expect(h.opened).toEqual([]);
  });

  it('⑧ 流式路径也画得上（临时 div 里画不上 ⇒ 由观察器在插入正文后补画）', () => {
    const box = contentWith('');
    streamInto(box, '<p>见 <code>apps/web/src/main.ts</code></p>');
    return tick().then(() => {
      const code = box.querySelector('code') as HTMLElement;
      expect(code.getAttribute('tabindex')).toBe('0');
      code.focus();
      expect(document.activeElement).toBe(code);
      keyOn(code, 'Enter');
      expect(h.opened).toEqual(['/ws/apps/web/src/main.ts']);
    });
  });

  it('⑨ 幂等：连跑三次不重复打标记、停靠点仍只有一个', () => {
    const box = contentWith('<p>见 <code>a/1.ts</code> 与 <code>a/2.ts</code></p>');
    runEnhancers(box);
    runEnhancers(box);
    runEnhancers(box);
    expect(hitsIn(box).length).toBe(2);
    expect(stopsIn(box).length).toBe(1);
    expect(box.querySelectorAll('.file-link-label').length).toBe(0); // 这一条没有 label 形态
  });

  it('⑪ 历史恢复路径：观察器拿到的节点是正文的**祖先**，也必须画上（真机抓到的真 bug）', () => {
    // ★ 必须忠实复刻 restore.ts:262 `ctx.el.replaceChildren(...off.childNodes)`：
    //   被搬进去的是**整列 .mcol**，而 .content.rendered 是它的**后代**；
    //   宿主 ctx.el（下面的 pane）**自己不是** .content.rendered。
    //   所以观察器回调里的 addedNode.closest('.content.rendered') === null ——
    //   只认「scope 在正文里」的写法在这里必然漏画（第一版就是这个 bug）。
    const pane = document.createElement('div');
    pane.className = 'sess-pane';           // 不是 .content.rendered
    document.body.appendChild(pane);
    const col = document.createElement('div');
    col.className = 'mcol';
    col.innerHTML = '<div class="msg assistant"><div class="bubble"><div class="content rendered">' +
      '<p>见 <code>apps/web/src/main.ts</code></p></div></div></div>';
    pane.appendChild(col);                  // ← 这一步触发观察器（scope = .mcol）
    return tick().then(() => {
      const box = pane.querySelector('.content.rendered') as HTMLElement;
      const code = box.querySelector('code') as HTMLElement;
      expect(code.getAttribute('tabindex')).toBe('0');
      code.focus();
      expect(document.activeElement).toBe(code);
      keyOn(code, 'Enter');
      expect(h.opened).toEqual(['/ws/apps/web/src/main.ts']);
    });
  });
  it('⑩ 「文件：x」切段后文本逐字不变、兄弟节点不动（只包路径段）', () => {
    const box = contentWith('<p>先看 <code>a/b.ts</code> 再看 文件：c/d.ts 完</p>');
    runEnhancers(box);
    const p = box.querySelector('p') as HTMLElement;
    expect(p.textContent).toBe('先看 a/b.ts 再看 文件：c/d.ts 完'); // 文本一字不差
    expect(p.querySelector('code')?.textContent).toBe('a/b.ts');      // code 节点身份没变
    const label = p.querySelector('.file-link-label') as HTMLElement;
    expect(label.textContent).toBe('c/d.ts');                          // 只有路径段被包起来
    expect(label.getAttribute('tabindex')).toBeDefined();
    label.focus();
    keyOn(label, 'Enter');
    expect(h.opened).toEqual(['/ws/c/d.ts']);
  });
});
