// @vitest-environment jsdom
/**
 * W9228 · 默认模型卡片的 **provider 消歧**（W9227 跨格线索 C4 / W9202 审计 P1-4）。
 *
 * 缺陷（修复前实测的形状）：两个 provider 列同名模型 ⇒ 两个 option 的 value 都是
 * `m.id`，界面上分不出选的是哪一个；change 时只发 `model`，后端
 * （handlers/providers.ts 的 provider_id 缺省分支）取**第一个**列出该 id 的 provider，
 * 并把它自己的 base_url 一起切成端点 ⇒ 用户选的是「基元 / deepseek-flash」，
 * 生效的可能是网关端点。
 *
 * 本文件钉住**修复的那一半**（选中的 option 带着真实 provider_id，请求体真的发出
 * 消歧参数）以及**修复没有假装做到的那一半**（回填的口径与已知边界，见用例 ④ 与
 * 报告 §C）。判据全部从真实 DOM（`renderDefaultPicker` 生产渲染器）与真实 fetch
 * 请求体里读，不复制实现逻辑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness, type ElLike } from './lib/w795-dom.js';

interface OptionLike extends ElLike {
  selected: boolean;
}
interface SelectLike extends ElLike {
  options: ArrayLike<OptionLike>;
  selectedIndex: number;
  selectedOptions: ArrayLike<OptionLike>;
}
interface StateMod {
  setProviderData(list: unknown[], def: string | null): void;
}
interface ListMod {
  renderDefaultPicker(container: ElLike, host: { loadProviders(): Promise<void> }): void;
}

/** state.ts 在 import 期 need('#settingsProviders')，宿主必须在位。 */
const HTML =
  '<div id="settingsPage"><section class="settings-pane" data-pane="providers">' +
  '<div id="settingsProviders"></div></section></div>';

/** 已发出的 POST 体（`/api/providers/default`）。 */
const posts: Array<Record<string, unknown>> = [];

/** 两个 provider 列**同名**模型 —— 生产里 deepseek-flash 的真实形状。 */
const DUP = [
  { id: 'gateway', name: 'Celestea 网关', models: [{ id: 'deepseek-flash', name: 'deepseek-flash' }] },
  { id: 'jiyuan', name: '基元', models: [{ id: 'deepseek-flash', name: 'deepseek-flash' }] },
];

function stubFetch(): void {
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown; method?: string }) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (u.startsWith('/api/providers/default') && method === 'POST') {
      posts.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return { ok: true, status: 200, json: async () => ({ ok: true, providers: [], default_model: 'deepseek-flash' }) };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not stubbed' }) };
  });
}

/** 装配真实渲染器：写入共享状态 → 画卡片 → 返回 select。 */
async function render(providers: unknown[], defaultModel: string | null): Promise<SelectLike> {
  const state = (await import(/* @vite-ignore */ at('ui/providers/state.ts'))) as StateMod;
  state.setProviderData(providers, defaultModel);
  const list = (await import(/* @vite-ignore */ at('ui/providers/list.ts'))) as ListMod;
  const host = doc.createElement('div') as unknown as ElLike;
  doc.body.appendChild(host);
  list.renderDefaultPicker(host as unknown as never, { loadProviders: async () => undefined });
  return host.querySelector('.prov-default-sel') as unknown as SelectLike;
}

/** 派发一次 change（选择框的真实交互路径）。 */
function choose(sel: SelectLike, index: number): void {
  sel.selectedIndex = index;
  sel.dispatchEvent(new (globalThis as unknown as { Event: new (t: string, i?: { bubbles?: boolean }) => Event }).Event('change', { bubbles: true }));
}

describe('W9228 · 默认模型卡片：撞名模型必须按 (provider, model) 消歧', () => {
  beforeEach(() => {
    resetHarness();
    doc.body.innerHTML = HTML;
    posts.length = 0;
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('① 两个 provider 列同名模型 ⇒ 每个 option 必须各自带真实身份', async () => {
    const sel = await render(DUP, null);
    const options = Array.from(sel.options);
    expect(options, '两个同名模型各占一行').toHaveLength(2);
    expect(options.map((o) => o.dataset['providerId']), '修复前两者都是 undefined').toEqual(['gateway', 'jiyuan']);
    expect(options.map((o) => o.dataset['model'])).toEqual(['deepseek-flash', 'deepseek-flash']);
  });

  it('② 选中第二个同名模型 ⇒ 请求体必须带 provider_id（端点才不会切错）', async () => {
    const sel = await render(DUP, null);
    choose(sel, 1);
    await vi.waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]).toEqual({ model: 'deepseek-flash', provider_id: 'jiyuan' });
  });

  it('③ 选中第一个同名模型 ⇒ provider_id 是它自己（不是「缺省」）', async () => {
    const sel = await render(DUP, null);
    choose(sel, 0);
    await vi.waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]).toEqual({ model: 'deepseek-flash', provider_id: 'gateway' });
  });

  it('④ 回填口径：选中项的 model 必须等于默认项，且不伪造 provider 身份', async () => {
    // ★ 诚实记录一个**已知边界**（W9228 实测，不是没测到）：
    // 回填仍走 `sel.value = <model>`。多个 option 共享同一个 value 时，HTML 规范
    // 规定 select 选中**第一个** value 匹配项；原生 option 的 selectedness 由
    // select 的 value/selectedIndex 两个写者共同决定，「按 (provider_id, model)
    // 精确回填」在纯 DOM 层没有可靠的写法（实测：赋 value 后再赋 selectedIndex
    // 会被随后的 value 写回覆盖）。后端的真正修法是把 default_provider_id 也
    // 回传（见报告 §C 的跨格线索），不在本文件的授权范围内。
    // 因此这里钉的是**回填的不变量**：选中的那一项必须真的列出该模型，且与
    // 后端 rows() 的「第一个列出者」规则一致 —— 绝不指向一个不列出它的 provider。
    const sel = await render([DUP[0]!, DUP[1]!], 'deepseek-flash');
    const chosen = sel.options[sel.selectedIndex];
    expect(chosen?.dataset['model'], '回填后选中项的 model 必须等于默认项').toBe('deepseek-flash');
    expect(chosen?.dataset['providerId']).toBe('gateway');
  });

  it('⑤ 默认项撞名、前端无从判断 ⇒ 退回「第一个列出者」（后端真正会选的那一个）', async () => {
    const sel = await render(DUP, 'deepseek-flash');
    expect(sel.selectedIndex, '退回按 model 匹配（= 后端会选的第一个列出者）').toBe(0);
    expect(sel.options[sel.selectedIndex]?.dataset['providerId']).toBe('gateway');
  });

  it('⑥ 不在列表的默认项 ⇒ 兜底行仍带 data-model，且不带 provider_id（不发明身份）', async () => {
    const sel = await render(DUP, 'ghost-model');
    const last = sel.options[sel.options.length - 1];
    expect(last?.value).toBe('ghost-model');
    expect(last?.dataset['model']).toBe('ghost-model');
    expect(last?.dataset['providerId']).toBeUndefined();
    choose(sel, sel.options.length - 1);
    await vi.waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0], '兜底行按旧契约只发 model').toEqual({ model: 'ghost-model' });
  });

  it('⑦ name 缺省时文案回落到 provider id（旧行为逐字保留）', async () => {
    const sel = await render([{ id: 'gw-a', models: [{ id: 'm1', name: 'm1' }] }], null);
    expect(sel.options[0]?.textContent).toBe('gw-a / m1');
  });
});
