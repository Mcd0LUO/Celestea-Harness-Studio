// @vitest-environment jsdom
/**
 * F4-01 · 「获取模型」不再静默落盘整张表单。
 *
 * 症状：编辑一个**已存在**的 provider，在行内联表单里改 name/备注但**不点保存**，
 * 点「获取模型」⇒ 旧实现先 `saveProvider(buildPayload(e))` 把整张表单写盘。
 * 于是「用户没点保存、甚至 fetch 随后失败」，半成品配置也已经生效，而列表行仍
 * 显示旧值（fetch 路径从不调 onSaved）—— 落盘与显示不一致，用户无从察觉。
 * 真机复现：results/audit3-r2/F4/probeG.mjs（落盘 UNSAVED-NAME，行仍 ProbeZ）。
 *
 * 根因：`POST /api/providers/{id}/models/fetch`（apps/studio/src/handlers/providers.ts:112）
 * 只做 `store.find(id)` 读既有行，**根本不需要先保存** —— 编辑既有 provider 时那次
 * saveProvider 纯属多余的副作用。
 *
 * 本文件钉住修复后的两条不变量：
 *   ① 编辑既有 provider：点「获取模型」⇒ **一次 POST 都不发**（直接 fetch）；
 *      即便 fetch 失败，也没有任何东西被写盘。
 *   ② 新建 provider：store 里还没有这一行，fetch 必然 404 ⇒ 仍需先落一行，
 *      但只落**探测必需的最小字段**，且不带上用户尚未确认的模型清单。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness, type ElLike } from './lib/w795-dom.js';

interface EditorRefs {
  root: ElLike;
  name: ElLike;
  note: ElLike;
  url: ElLike;
  key: ElLike;
  rows: Array<{ id: ElLike; name: ElLike }>;
}
interface FormMod {
  buildProviderForm(p: unknown, hooks: unknown): EditorRefs;
}
interface I18nMod {
  setLocale(l: string): void;
}

/** state.ts 在 import 期 need('#settingsProviders')，宿主必须在位。 */
const HTML =
  '<div id="settingsPage"><section class="settings-pane" data-pane="providers">' +
  '<div id="settingsProviders"></div></section></div>';

interface Call {
  url: string;
  body: string;
}
const calls: Call[] = [];
let fetchStatus = 200;
let fetchPayload: unknown = { ok: true, models: [{ id: 'remote-a' }] };

const jsonReply = (status: number, payload: unknown): unknown => ({
  ok: status < 300,
  status,
  json: async () => payload,
});

function stubFetch(): void {
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown; method?: string }) => {
    calls.push({ url: String(url), body: init?.body === undefined ? '' : String(init.body) });
    return jsonReply(fetchStatus, fetchPayload);
  });
}

async function boot(existing: unknown): Promise<EditorRefs> {
  const form = (await import(/* @vite-ignore */ at('ui/providers/form.ts'))) as FormMod;
  return form.buildProviderForm(existing, { onSaved: () => {}, onCancel: () => {} });
}

const fetchBtn = (refs: EditorRefs): ElLike => {
  const b = Array.from(refs.root.querySelectorAll('button')).find((x) =>
    (x.textContent ?? '').includes('获取模型'),
  );
  if (b === undefined) throw new Error('fetch button missing');
  return b;
};
const saveCalls = (): Call[] => calls.filter((c) => c.url.startsWith('/api/providers') && !c.url.includes('models/fetch'));
const fetchCalls = (): Call[] => calls.filter((c) => c.url.includes('models/fetch'));

describe('F4-01 · 「获取模型」不再静默落盘整张表单', () => {
  beforeEach(async () => {
    resetHarness();
    doc.body.innerHTML = HTML;
    calls.length = 0;
    fetchStatus = 200;
    fetchPayload = { ok: true, models: [{ id: 'remote-a' }] };
    stubFetch();
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
    i18n.setLocale('zh');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('编辑既有 provider：点「获取模型」不发任何保存请求（只 fetch）', async () => {
    const refs = await boot({
      id: 'p1',
      name: 'ORIGINAL',
      note: 'ORIGINAL-NOTE',
      base_url: 'https://example.com/v1',
      request_format: 'chat_completions',
      models: [{ id: 'm1', name: 'm1' }],
    });
    // 用户改了 name/备注但**不点保存**。
    (refs.name as unknown as { value: string }).value = 'UNSAVED-NAME';
    (refs.note as unknown as { value: string }).value = 'UNSAVED-NOTE';
    fetchBtn(refs).click();
    await vi.waitFor(() => expect(fetchCalls().length).toBe(1));
    expect(
      saveCalls().length,
      '发现型动作不得写盘：编辑既有 provider 时一次 saveProvider 都不该发',
    ).toBe(0);
    expect(fetchCalls()[0]?.url, 'fetch 用既有身份 originalId').toContain('/api/providers/p1/models/fetch');
  });

  it('编辑既有 provider：fetch 失败也绝不写盘', async () => {
    fetchStatus = 500;
    fetchPayload = { ok: false, error: 'boom' };
    const refs = await boot({
      id: 'p1',
      name: 'ORIGINAL',
      base_url: 'https://example.com/v1',
      request_format: 'chat_completions',
      models: [{ id: 'm1', name: 'm1' }],
    });
    (refs.name as unknown as { value: string }).value = 'UNSAVED-NAME';
    fetchBtn(refs).click();
    await vi.waitFor(() => expect(fetchCalls().length).toBe(1));
    expect(saveCalls().length, 'fetch 失败更不能把半成品写下去').toBe(0);
  });

  it('新建 provider：仍先落一行（否则 fetch 必 404），但只落探测最小字段', async () => {
    const refs = await boot(null);
    (refs.name as unknown as { value: string }).value = 'newprov';
    (refs.url as unknown as { value: string }).value = 'https://example.com/v1';
    fetchBtn(refs).click();
    await vi.waitFor(() => expect(fetchCalls().length).toBe(1));
    const saved = saveCalls();
    expect(saved.length, '新建时 store 里没有这一行，必须先落一行').toBe(1);
    const body = JSON.parse(saved[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['id']).toBe('newprov');
    expect(body['base_url']).toBe('https://example.com/v1');
    expect(
      body['models'],
      '探测那一行不带用户尚未确认的模型清单',
    ).toEqual([]);
  });
});