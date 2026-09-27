// @vitest-environment jsdom
/**
 * W9227 · P1-1 前端半边：真实 API 形状下「缺键 ⇒ 三片全选」必须可达。
 *
 * 上一轮（W9202）把 form.ts 的注释改成「absent 不可达」并新增了一条测试，钉的是
 * **当时后端的归一化行为**（parseModel 把缺键变成 `[]`）。W9227 修掉了根因（后端保真），
 * 于是这条路径重新可达 —— 本文件把**真实 API 会喂什么**钉死：
 *   · `GET /api/providers` 对一个从未配过 reasoning_efforts 的模型**不发**该键
 *     （apps/studio/src/store/providers.ts 的 effortsList/view）；
 *   · 前端收到 absent ⇒ 回填三片全选（乐观默认），收到 `[]` ⇒ 一片不留。
 *
 * 与 tests/w9202-config-provider-fixes.test.ts 的关系：那条测「显式 [] ⇒ 零片」，
 * 本文件测「缺键 ⇒ 三片」，两条一起把两个状态**同时**钉住。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness, type ElLike } from './lib/w795-dom.js';

interface EffortChips {
  root: ElLike;
  set(values: readonly string[] | undefined): void;
  values(): string[];
}
interface ModelRowHandle {
  id: ElLike;
  name: ElLike;
  efforts: EffortChips;
  li: ElLike;
}
interface EditorRefs {
  root: ElLike;
  modelsBox: ElLike;
  rows: ModelRowHandle[];
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

const posts: string[] = [];

function stubSave(): void {
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown; method?: string }) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (u.startsWith('/api/providers') && method === 'POST') {
      posts.push(init?.body === undefined ? '' : String(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, id: 'p1' }) };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not stubbed' }) };
  });
}

/** 用「服务端读回的模型清单」建表单（走真实回填路径）。 */
async function boot(models: unknown[]): Promise<EditorRefs> {
  const form = (await import(/* @vite-ignore */ at('ui/providers/form.ts'))) as FormMod;
  return form.buildProviderForm(
    {
      id: 'p1',
      name: 'p1',
      note: '',
      base_url: 'https://example.com/v1',
      request_format: 'chat_completions',
      models,
    },
    { onSaved: () => {}, onCancel: () => {} },
  );
}

const chips = (row: ModelRowHandle): ElLike[] =>
  Array.from(row.efforts.root.querySelectorAll('.prov-effort-chip'));

describe('W9227 P1-1 · 前端回填：真实 API 的缺键形状 ⇒ 乐观默认三片', () => {
  beforeEach(async () => {
    resetHarness();
    doc.body.innerHTML = HTML;
    posts.length = 0;
    stubSave();
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
    i18n.setLocale('zh');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('缺 reasoning_efforts 键（真实 API 对从未配置的模型发的形状）⇒ 三片全选', async () => {
    // 关键：这个对象里**没有** reasoning_efforts —— 与 GET /api/providers 的实际外发一致。
    const refs = await boot([{ id: 'legacy', name: 'legacy' }]);
    const row = refs.rows[0]!;
    expect(chips(row).map((c) => c.dataset['effort'])).toEqual(['low', 'high', 'max']);
    expect(row.efforts.values()).toEqual(['low', 'high', 'max']);
    for (const c of chips(row)) {
      expect(c.classList.contains('on'), (c.dataset['effort'] ?? '') + ' 必须选中').toBe(true);
    }
  });

  it('显式 [] ⇒ 一片不留（两个状态并存、互不覆盖）', async () => {
    const refs = await boot([
      { id: 'legacy', name: 'legacy' },
      { id: 'explicit', name: 'explicit', reasoning_efforts: [] },
    ]);
    expect(chips(refs.rows[0]!)).toHaveLength(3);
    expect(refs.rows[0]!.efforts.values()).toEqual(['low', 'high', 'max']);
    expect(chips(refs.rows[1]!)).toHaveLength(0);
    expect(refs.rows[1]!.efforts.values()).toEqual([]);
  });

  it('缺键的行保存后仍带三档（写回语义本轮未改，P2-4 是另一条线）', async () => {
    const refs = await boot([{ id: 'legacy', name: 'legacy' }]);
    const save = Array.from(refs.root.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('保存'));
    save?.click();
    await vi.waitFor(() => expect(posts.length).toBe(1));
    const body = JSON.parse(posts[0] ?? '{}') as { models?: Array<Record<string, unknown>> };
    expect(body.models?.[0]?.['reasoning_efforts']).toEqual(['low', 'high', 'max']);
  });
});
