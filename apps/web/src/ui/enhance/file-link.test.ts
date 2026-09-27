// @vitest-environment jsdom
// ============================================================================
// W2013（A.5）验收：正文里的文件路径 ⇒ 已有预览面板。
//
// 本文件守四件事，每件都对应一条**变异负控制**（见报告）：
//   ① 幂等 —— 流式每节拍重跑整条链，委托监听只能挂一次（dataset.fileLinkDone）；
//   ② 不抢外链 —— 锚点与 scheme URL 都不能被本遍拦下；
//   ③ order > ORDER_MATH —— 声明式顺序，不随注册时机漂移；
//   ④ 复用 detectFromText —— 不另写正则（口径唯一）。
//
// ★ 本文件用**真实流式路径**跑幂等，不手搓容器：assistant.ts:103-108 的
//   runEnhancersOnFragment 会把新节点搬进一个临时 div 再搬回来 —— 这正是
//   「容器级监听会死」的那个坑（W2013 探针实测 hits=[]），必须由用例钉住。
//
// ★ 点击一律派发在**元素**上：真机点击是命中测试到最近的元素，事件目标不会是
//   文本节点；在文本节点上 dispatchEvent 是测试里才会出现的形态，不忠实。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_LINK_ID, ORDER_FILE_LINK, fileLinkEnhancer } from './file-link';
import { ORDER_HLJS, ORDER_MATH } from './builtin';
import { enhancerIds, registerEnhancer, runEnhancers } from './registry';
import { deactivatePlugin, registerEnhancerPlugin } from '../../plugins/register';

// 依赖替换：只换「打开文件」与「工作区根」两个副作用出口，判定与委托逻辑全走真代码。
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

/** 在元素上派发一次可取消的点击，返回事件（看 defaultPrevented）。 */
function clickOn(el: Element): MouseEvent {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
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

describe('W2013 正文文件链接 ⇒ 预览面板', () => {
  it('① 幂等：走真实流式路径连跑三次，点击只触发一次（委托只挂一次）', () => {
    const box = contentWith('');
    // 三次流式 tick：每次都走 runEnhancersOnFragment（临时 div）那条路。
    streamInto(box, '<p>见 <code>apps/web/src/main.ts</code></p>');
    streamInto(box, '<p>补一句</p>');
    streamInto(box, '<p>再补一句</p>');
    // 幂等标记落在**委托宿主**（body）上 —— 而不是那个活不过一次 tick 的临时 div。
    expect(document.body.dataset['fileLinkDone']).toBe('1');
    clickOn(box.querySelector('code') as Element);
    // 挂一次 ⇒ 开一次；若每 tick 都挂，这里会是 3 次。
    expect(h.opened).toEqual(['/ws/apps/web/src/main.ts']);
  });

  it('①b 幂等：重复 enhance 同一容器不会重复挂（计数法）', () => {
    const box = contentWith('<p>见 <code>a/b.ts</code></p>');
    runEnhancers(box);
    runEnhancers(box);
    runEnhancers(box);
    clickOn(box.querySelector('code') as Element);
    expect(h.opened.length).toBe(1);
  });

  it('② 不抢外链：锚点与 https URL 都不被拦下', () => {
    // ★ 用例必须挑**真的会被判定命中**的锚点，否则它测不到守卫（本遍的变异
    //   负控制 M2 实测抓到：早期写成裸文本 `docs/readme.md`，detectFromText 对
    //   它返回空 ⇒ 删掉锚点守卫这条用例照样绿 —— 假绿。下面两种形态才是真考验：
    //   它们的锚点**内容**本身就是合法路径，只有锚点守卫能拦住。
    // (a) markdown 链接里套行内反引号：[`/a/b.md`](https://…) ⇒ <a><code>…</code></a>
    const box = contentWith(
      '<p><a href="https://example.com/x"><code>docs/readme.md</code></a></p>',
    );
    runEnhancers(box);
    const evA = clickOn(box.querySelector('a code') as Element);
    expect(h.opened).toEqual([]);
    expect(evA.defaultPrevented).toBe(false); // 默认行为没被抢
    // (b) 「文件：x」句式作锚点正文：[文件：/etc/x.json](https://…) ⇒ 文本节点分支
    const box2 = contentWith(
      '<p><a href="https://example.com/y">文件：/etc/x.json</a></p>',
    );
    runEnhancers(box2);
    const evB = clickOn(box2.querySelector('a') as Element);
    expect(h.opened).toEqual([]);
    expect(evB.defaultPrevented).toBe(false);
    // (c) 非锚点形态的 URL（行内代码里裸写）⇒ looksLikePath 判它不是路径。
    const box3 = contentWith('<p><code>https://example.com/a.ts</code></p>');
    runEnhancers(box3);
    const evC = clickOn(box3.querySelector('code') as Element);
    expect(h.opened).toEqual([]);
    expect(evC.defaultPrevented).toBe(false);
  });

  it('③ order 必须晚于 ORDER_HLJS / ORDER_MATH（声明式，不看注册时机）', () => {
    expect(ORDER_FILE_LINK).toBeGreaterThan(ORDER_HLJS);
    expect(ORDER_FILE_LINK).toBeGreaterThan(ORDER_MATH);
    // 真实排序：内置两遍由 ./builtin 在模块加载时已注册，本遍**后**注册也必须排在它们之后。
    const ids = enhancerIds();
    expect(ids).toContain(FILE_LINK_ID);
    expect(ids.indexOf('builtin.hljs')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('builtin.hljs')).toBeLessThan(ids.indexOf(FILE_LINK_ID));
    expect(ids.indexOf('builtin.math')).toBeLessThan(ids.indexOf(FILE_LINK_ID));
  });

  it('④ 复用 detectFromText：「文件：x」句式（文本节点分支）可点开', () => {
    const box = contentWith('<p>文件：src/ui/send.ts</p>');
    runEnhancers(box);
    const ev = clickOn(box.querySelector('p') as Element);
    expect(h.opened).toEqual(['/ws/src/ui/send.ts']);
    expect(ev.defaultPrevented).toBe(true); // 真的接管了这次点击
  });

  it('④b 裸词 / 无扩展名一律不算（判定来自 detect.ts，不另写正则）', () => {
    const box = contentWith('<p>见 <code>src</code> 与 <code>README</code></p>');
    runEnhancers(box);
    for (const c of Array.from(box.querySelectorAll('code'))) clickOn(c);
    expect(h.opened).toEqual([]);
  });

  it('⑤ 关掉后真的不再接管（注册表是唯一真源；监听还在 body 上）', () => {
    const box = contentWith('<p>见 <code>a/b.ts</code></p>');
    runEnhancers(box);
    off?.(); // 真注销（＝设置页关开关）
    off = null;
    clickOn(box.querySelector('code') as Element);
    expect(h.opened).toEqual([]);
  });

  it('⑥ 预览面板自己的正文不递归开新预览（作用域只认 .content.rendered）', () => {
    const box = document.createElement('div');
    box.className = 'preview-body rendered';
    box.innerHTML = '<p>见 <code>a/b.ts</code></p>';
    document.body.appendChild(box);
    runEnhancers(box);
    clickOn(box.querySelector('code') as Element);
    expect(h.opened).toEqual([]);
  });

  it('⑦ 代码块里的 code 不接管（pre > code 是拿来复制的）', () => {
    const box = contentWith('<pre><code>a/b.ts</code></pre>');
    runEnhancers(box);
    const ev = clickOn(box.querySelector('code') as Element);
    expect(h.opened).toEqual([]);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('⑧ 工作区解析不到 ⇒ 不打开（宁可不做，也不猜绝对路径）', () => {
    h.wsRoot = '';
    const box = contentWith('<p>见 <code>a/b.ts</code></p>');
    runEnhancers(box);
    clickOn(box.querySelector('code') as Element);
    expect(h.opened).toEqual([]);
  });

  it('⑨ 绝对路径原样打开（不再拼工作区根）', () => {
    const box = contentWith('<p>见 <code>/abs/path/x.ts</code></p>');
    runEnhancers(box);
    clickOn(box.querySelector('code') as Element);
    expect(h.opened).toEqual(['/abs/path/x.ts']);
  });

  it('⑩ 注册进插件登记表后，可从缝上真注销（与其它增强同一套开关）', () => {
    off?.();
    off = null;
    registerEnhancerPlugin(fileLinkEnhancer());
    expect(enhancerIds()).toContain(FILE_LINK_ID);
    deactivatePlugin(FILE_LINK_ID);
    expect(enhancerIds()).not.toContain(FILE_LINK_ID);
  });
});
