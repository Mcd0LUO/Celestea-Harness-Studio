// @vitest-environment jsdom
/**
 * F4-03 / F4-04 · 提供商表单的两条校验不变量。
 *
 * F4-03「预保存的结果被忽略」：`requestJson` 对 4xx/5xx 抛 ApiError（api.ts:128），
 *   但 **HTTP 200 + `{ok:false,error}` 不抛** —— 那是 `ClearResp` 契约允许的形状
 *   （types/batch.ts 的 `OkResp`）。「获取模型」的预保存链旧代码是
 *   `.then(() => api.fetchProviderModels(id))`，无视回执 ⇒ 保存被拒也照样继续拉模型，
 *   用户拿到基于**旧配置**的模型清单，却以为保存好了。
 *   修法：抽 `checkSaved` 复用，两条路径同一口径（被拒即抛，交给 .catch 渲染）。
 *
 * F4-04「半填模型行静默消失」：旧过滤是 `id || name`（**或**），所以「只填了显示名、
 *   id 空着」的行会进 payload，但后端 `parseModel` 遇 `id === ''` 整行 `return null`
 *   （apps/studio/src/store/providers.ts:287）⇒ 整行蒸发且无任何提示。
 *   修法：保存/获取前显式拦下并说清是哪一行缺 id（空行仍照旧跳过）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ModelRowHandle {
  id: ElLike;
  name: ElLike;
}
interface EditorRefs {
  root: ElLike;
  name: ElLike;
  url: ElLike;
  rows: ModelRowHandle[];
  status: ElLike;
}
interface FormMod {
  buildProviderForm(p: unknown, hooks: unknown): EditorRefs;
}
interface I18nMod {
  setLocale(l: string): void;
}

const HTML =
  '<div id="settingsPage"><section class="settings-pane" data-pane="providers">' +
  '<div id="settingsProviders"></div></section></div>';

interface Call {
  url: string;
  body: string;
}
const calls: Call[] = [];
/** 逐次决定第 n 个响应的状态码与体（默认全 200 ok）。 */
let replies: Array<{ status: number; payload: unknown }> = [];

function stubFetch(): void {
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown; method?: string }) => {
    calls.push({ url: String(url), body: init?.body === undefined ? '' : String(init.body) });
    const r = replies.shift() ?? { status: 200, payload: { ok: true, models: [{ id: 'remote-a' }] } };
    return { ok: r.status < 300, status: r.status, json: async () => r.payload };
  });
}

async function boot(existing: unknown): Promise<EditorRefs> {
  const form = (await import(/* @vite-ignore */ at('ui/providers/form.ts'))) as FormMod;
  return form.buildProviderForm(existing, { onSaved: () => {}, onCancel: () => {} });
}

const btn = (refs: EditorRefs, re: RegExp): ElLike => {
  const b = Array.from(refs.root.querySelectorAll('button')).find((x) => re.test(x.textContent ?? ''));
  if (b === undefined) throw new Error('button missing for ' + re);
  return b;
};
const saveBtn = (r: EditorRefs): ElLike => btn(r, /保存/);
const fetchBtn = (r: EditorRefs): ElLike => btn(r, /获取模型/);
const isFetch = (c: Call): boolean => c.url.includes('models/fetch');
const fetchCalls = (): Call[] => calls.filter(isFetch);
const saveCalls = (): Call[] => calls.filter((c) => !isFetch(c));
const statusText = (r: EditorRefs): string => (r.status.textContent ?? '').trim();
const setVal = (i: ElLike, v: string): void => { (i as unknown as { value: string }).value = v; };

const EXISTING = {
  id: 'p1',
  name: 'ORIGINAL',
  base_url: 'https://example.com/v1',
  request_format: 'chat_completions',
  models: [{ id: 'm1', name: 'm1' }],
};

describe('F4-03 · 预保存被拒时不得继续获取模型', () => {
  beforeEach(async () => {
    resetHarness();
    doc.body.innerHTML = HTML;
    calls.length = 0;
    replies = [];
    stubFetch();
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
    i18n.setLocale('zh');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('新建时预保存回 200+ok:false ⇒ 不得再发 models/fetch', async () => {
    // ClearResp 的合法形状：HTTP 200 但 {ok:false}（api 层**不抛**）
    replies = [{ status: 200, payload: { ok: false, error: 'base_url is required' } }];
    const refs = await boot(null);
    setVal(refs.name, 'newprov');
    setVal(refs.url, 'https://example.com/v1');
    fetchBtn(refs).click();
    // 状态行出现「保存失败」才是 .catch 跑完的信号（比固定 tick 可靠）
    await vi.waitFor(() => expect(statusText(refs)).toContain('保存失败'));
    expect(
      fetchCalls().length,
      '保存被拒时不得继续拉模型（否则清单基于旧配置）',
    ).toBe(0);
    expect(statusText(refs), '失败原因要显示给用户').toContain('base_url is required');
  });

  it('新建时预保存成功 ⇒ 照常继续获取模型', async () => {
    replies = [
      { status: 200, payload: { ok: true } },
      { status: 200, payload: { ok: true, models: [{ id: 'remote-a' }] } },
    ];
    const refs = await boot(null);
    setVal(refs.name, 'newprov');
    setVal(refs.url, 'https://example.com/v1');
    fetchBtn(refs).click();
    await vi.waitFor(() => expect(fetchCalls().length).toBe(1));
    expect(saveCalls().length).toBe(1);
  });

  it('保存按钮：200+ok:false 不调用 onSaved，状态行报原因', async () => {
    let saved = 0;
    const form = (await import(/* @vite-ignore */ at('ui/providers/form.ts'))) as FormMod;
    const refs = form.buildProviderForm(EXISTING, {
      onSaved: () => { saved += 1; },
      onCancel: () => {},
    });
    replies = [{ status: 200, payload: { ok: false, error: 'base_url must be an http:// or https:// URL' } }];
    saveBtn(refs).click();
    await vi.waitFor(() => expect(statusText(refs)).toContain('保存失败'));
    expect(saved, '被拒不得当成保存成功').toBe(0);
    expect(statusText(refs)).toContain('base_url must be an http:// or https:// URL');
  });
});

describe('F4-04 · 半填模型行不再静默消失', () => {
  beforeEach(async () => {
    resetHarness();
    doc.body.innerHTML = HTML;
    calls.length = 0;
    replies = [];
    stubFetch();
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
    i18n.setLocale('zh');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('只填显示名、id 空着 ⇒ 保存被拦下并点名那一行（不 POST）', async () => {
    const refs = await boot(EXISTING);
    setVal(refs.rows[0]!.name, '只有显示名');
    setVal(refs.rows[0]!.id, '');
    saveBtn(refs).click();
    await vi.waitFor(() => expect(statusText(refs)).toContain('只有显示名'));
    expect(saveCalls().length, '半填行不得被 POST 出去再被服务端丢弃').toBe(0);
  });

  it('两列都空的行照旧跳过（那才是「没在编辑」）', async () => {
    const refs = await boot(EXISTING);
    const addBtn = btn(refs, /添加模型/);
    addBtn.click(); // 点了「+ 添加模型」但一个字没填
    expect(refs.rows.length).toBe(2);
    replies = [{ status: 200, payload: { ok: true } }];
    saveBtn(refs).click();
    await vi.waitFor(() => expect(saveCalls().length).toBe(1));
    const body = JSON.parse(saveCalls()[0]?.body ?? '{}') as { models?: unknown[] };
    expect(body.models?.length, '空行被跳过，只剩真正的 m1').toBe(1);
  });

  it('「获取模型」同样拦下半填行（否则预保存那一步也带不走它）', async () => {
    const refs = await boot(null);
    setVal(refs.name, 'newprov');
    setVal(refs.url, 'https://example.com/v1');
    const addBtn = btn(refs, /添加模型/);
    addBtn.click();
    setVal(refs.rows[0]!.name, '半填');
    fetchBtn(refs).click();
    await vi.waitFor(() => expect(statusText(refs)).toContain('半填'));
    expect(calls.length, '连预保存都不该发生').toBe(0);
  });
});