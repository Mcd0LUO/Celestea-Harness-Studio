// @vitest-environment jsdom
/**
 * B5-01 · 换档确认门的前端配套。
 *
 * 后端把 PUT /api/sessions/{id}/permission 接到与 grants 同一道人工确认门
 * （同源证据 + HttpOnly nonce cookie + 一次性令牌 + TTL），所以前端**裸 PUT 必然
 * 403**。本文件钉住两件事：
 *
 *   ① 切换流程**先取一次性令牌、再带令牌 PUT**（顺序与请求头本身就是契约）；
 *   ② 令牌取数失败 / 403 / 422 一律回滚徽标并说明原因，界面不卡在错误态。
 *
 * 口径来源：
 *   - 后端确认门  apps/studio/src/handlers/permissions.ts
 *   - 令牌绑定    security/scope-hash.ts 的 permissionScopeHash
 *                 （{"cap":"permission","scope":{"preset":"<档位>"}} 的 sha256）
 *   - 既有重试    ui/grants/flow.ts 的 submitGrant（403/409 重取一枚再试一次）
 *
 * 这里**自带 fetch 打桩**而不是复用 tests/lib/w795-dom.ts 的共享夹具：共享夹具的
 * 路由表管不到 /permission/confirm-token，且改它会波及其他并行审计的文件。
 * 加载的是**真实模块**（ui/permissions/store + statusline/permission/tier）。
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, type ElLike } from './lib/w795-dom.js';

const SESSION = 'ws/s1';

interface Call {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}

/** 服务端事实 + 故障注入（beforeEach 复位）。 */
const server = {
  calls: [] as Call[],
  /** 铸造端点答复；token 为空串 = 服务端没给令牌。 */
  tokenStatus: 200,
  token: 'perm-tok-1',
  /** PUT 答复。 */
  putStatus: 200,
  putError: 'permission confirmation required',
  /** 第一次 PUT 强制 403（模拟令牌过期），之后放行。 */
  put403Once: false,
  /** 服务端真正落库的档位（GET 与 PUT 都读它）。 */
  stored: 'full-access',
};

function reply(status: number, payload: unknown): unknown {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

const queryOf = (url: string, key: string): string => {
  const m = new RegExp('[?&]' + key + '=([^&]*)').exec(url);
  return m?.[1] === undefined ? '' : decodeURIComponent(m[1]);
};

const BUILTIN = [
  { id: 'read-only', label: 'Read only', network: false, workspaceWritable: false, toolRootsWritable: false, writeRoots: [], allPaths: false, unsandboxed: false, toolDeny: ['write_file'] },
  { id: 'write-read', label: 'Write + read', network: false, workspaceWritable: true, toolRootsWritable: false, writeRoots: [], allPaths: false, unsandboxed: false, toolDeny: [] },
  { id: 'full-access', label: 'Full access', network: true, workspaceWritable: true, toolRootsWritable: true, writeRoots: [], allPaths: true, unsandboxed: true, toolDeny: [] },
];

beforeEach(() => {
  server.calls = [];
  server.tokenStatus = 200;
  server.token = 'perm-tok-1';
  server.putStatus = 200;
  server.putError = 'permission confirmation required';
  server.put403Once = false;
  server.stored = 'full-access';
  doc.body.replaceChildren();
  vi.resetModules();
  vi.stubGlobal('TextEncoder', TextEncoder);
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown; method?: string; headers?: Record<string, string> }) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body === undefined ? '' : String(init.body);
    server.calls.push({ url: u, method, body, headers: (init?.headers as Record<string, string>) ?? {} });

    if (u.includes('/permission/confirm-token')) {
      if (server.tokenStatus !== 200) return reply(server.tokenStatus, { ok: false, error: 'not available' });
      return reply(200, { ok: true, token: server.token, expires_at: 1700000060 });
    }
    if (/\/permission$/.test(u) && method === 'PUT') {
      if (server.put403Once) {
        server.put403Once = false;
        return reply(403, { ok: false, error: 'permission confirmation required' });
      }
      if (server.putStatus !== 200) return reply(server.putStatus, { ok: false, error: server.putError });
      const preset = String((JSON.parse(body === '' ? '{}' : body) as { preset?: unknown }).preset ?? '');
      server.stored = preset;
      return reply(200, { ok: true, session: SESSION, preset, effective: {} });
    }
    if (/\/permission$/.test(u)) {
      return reply(200, { ok: true, session: SESSION, preset: server.stored, effective: {} });
    }
    if (u.startsWith('/api/permissions/presets')) {
      return reply(200, { ok: true, builtin: BUILTIN, custom: [], max: 'full-access' });
    }
    return reply(404, { ok: false });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

/** 动态加载的前端模块的最小结构（at() 返回 file URL，TS 跟不进去，只能在此声明）。 */
interface StoreMod {
  ensurePresets(force?: boolean): Promise<{ builtin: unknown[]; custom: unknown[]; max: string }>;
}
interface TierMod {
  resetTierStatus(): void;
  tierSection(host: never, repaint: () => void): ElLike;
}
interface ScopeHashMod {
  permissionScopeHash(preset: string): Promise<string>;
}

interface FakeHost {
  sessionId: string;
  currentPreset: string;
  applied: string[];
  notes: string[];
  applyPermission(id: string, label?: string): void;
  setNote(text: string, ms?: number): void;
}

/** tier.ts 依赖的宿主最小替身（只用到这四个成员）。 */
function fakeHost(current = 'full-access'): FakeHost {
  return {
    sessionId: SESSION,
    currentPreset: current,
    applied: [],
    notes: [],
    applyPermission(id) {
      this.currentPreset = id;
      this.applied.push(id);
    },
    setNote(text) {
      this.notes.push(text);
    },
  };
}

/**
 * 装好档位清单并渲染 §1 段（真实模块 + 真实 DOM）。
 *
 * `repaint` 必须真的**重画整段**：失败回滚时 tier.ts 把状态行写进模块状态再调用
 * repaint，一个 no-op 的 repaint 会让断言读到旧 DOM（那是测试的锅，不是产品的锅）。
 * 所以这里保存当前宿主，重画时把整段换掉。
 */
async function mountTier() {
  const store = (await import(/* @vite-ignore */ at('ui/permissions/store.ts'))) as StoreMod;
  await store.ensurePresets(true);
  const tier = (await import(/* @vite-ignore */ at('statusline/permission/tier.ts'))) as TierMod;
  tier.resetTierStatus();
  const ctx: { host: FakeHost; box: ElLike | null } = { host: null as never, box: null };
  const repaint = () => {
    const next = tier.tierSection(ctx.host as never, repaint);
    (ctx.box as unknown as { replaceWith(n: unknown): void } | null)?.replaceWith(next);
    ctx.box = next;
  };
  return { tier, repaint, ctx };
}

/** 点掉 §1 段里某个档位（走 tier.ts 自己的点击处理）。 */
function clickTier(box: ElLike, presetId: string): void {
  const row = Array.from(box.querySelectorAll('button[data-preset]')).find(
    (b) => b.dataset['preset'] === presetId,
  );
  if (row === undefined) throw new Error('tier row not found: ' + presetId);
  row.click();
}

/** 渲染一段并返回「点选 + 拿到最新 DOM」的小工具。 */
async function renderTier() {
  const { tier, repaint, ctx } = await mountTier();
  const h = fakeHost();
  ctx.host = h;
  const first = tier.tierSection(h as never, repaint);
  doc.body.appendChild(first);
  ctx.box = first;
  return {
    host: h,
    /** 当前生效的 DOM（回滚重画后用它读状态行）。 */
    dom: () => ctx.box as ElLike,
    pick: (presetId: string) => clickTier(ctx.box as ElLike, presetId),
  };
}

/** 把微任务队列排空若干轮（真实模块的 async 链路）。 */
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

const confirmCalls = () => server.calls.filter((c) => c.url.includes('/permission/confirm-token'));
const putCalls = () => server.calls.filter((c) => c.method === 'PUT' && c.url.includes('/permission'));

describe('B5-01 · 换档先取一次性令牌再 PUT', () => {
  it('顺序：GET confirm-token 在 PUT 之前，且 PUT 带 x-celestea-grant-confirm 头', async () => {
    const { host: h, pick } = await renderTier();

    pick('read-only');
    await settle();

    expect(confirmCalls(), '必须先取令牌').toHaveLength(1);
    expect(putCalls(), '然后才 PUT').toHaveLength(1);
    const order = server.calls.findIndex((c) => c.url.includes('/permission/confirm-token'));
    const putAt = server.calls.findIndex((c) => c.method === 'PUT' && c.url.includes('/permission'));
    expect(order).toBeGreaterThanOrEqual(0);
    expect(putAt).toBeGreaterThan(order);
    expect(putCalls()[0]?.headers['X-Celestea-Grant-Confirm']).toBe('perm-tok-1');
    expect(h.currentPreset).toBe('read-only');
  });

  it('令牌请求带目标档位与该档位的 scope_hash（令牌不能跨档复用）', async () => {
    const { pick } = await renderTier();
    pick('read-only');
    await settle();

    const url = confirmCalls()[0]?.url ?? '';
    expect(queryOf(url, 'preset')).toBe('read-only');
    const want = createHash('sha256')
      .update(JSON.stringify({ cap: 'permission', scope: { preset: 'read-only' } }))
      .digest('hex');
    expect(queryOf(url, 'scope_hash')).toBe(want);
  });

  it('403 ⇒ 重取一枚令牌再试一次（沿用 grants 的重试口径）', async () => {
    server.put403Once = true;
    const { host: h, pick } = await renderTier();
    pick('read-only');
    await settle(10);

    expect(confirmCalls(), '403 后应重取令牌').toHaveLength(2);
    expect(putCalls()).toHaveLength(2);
    expect(h.currentPreset, '重试成功后徽标保持新档').toBe('read-only');
  });
});

describe('B5-01 · 失败一律回滚徽标并说明原因', () => {
  it('令牌取数失败 ⇒ 不发 PUT、回滚徽标、说明原因', async () => {
    server.tokenStatus = 403;
    const { host: h, pick, dom } = await renderTier();
    pick('read-only');
    await settle();

    expect(putCalls(), '没拿到令牌就不该 PUT').toHaveLength(0);
    expect(h.applied, '乐观切档 → 回滚到原档').toEqual(['read-only', 'full-access']);
    expect(h.currentPreset).toBe('full-access');
    const status = dom().querySelector('.sl-popup-status');
    expect(status?.textContent ?? '', '失败要就地说明原因').not.toBe('');
  });

  it('403 重试仍失败 ⇒ 回滚并说明', async () => {
    server.putStatus = 403;
    const { host: h, pick, dom } = await renderTier();
    pick('read-only');
    await settle(10);

    expect(h.currentPreset).toBe('full-access');
    expect(h.applied).toEqual(['read-only', 'full-access']);
    const status = dom().querySelector('.sl-popup-status');
    expect(status?.textContent ?? '').not.toBe('');
  });

  it('422 ⇒ 透传服务端原因并回滚', async () => {
    server.putStatus = 422;
    server.putError = "unknown preset 'read-only'";
    const { host: h, pick, dom } = await renderTier();
    pick('read-only');
    await settle();

    expect(h.currentPreset).toBe('full-access');
    const status = dom().querySelector('.sl-popup-status');
    expect(status?.textContent ?? '').toContain("unknown preset 'read-only'");
  });
});

describe('B5-01 · 令牌摘要口径与服务端逐字一致', () => {
  it('permissionScopeHash 与独立复算对拍', async () => {
    const { permissionScopeHash } = (await import(/* @vite-ignore */ at('security/scope-hash.ts'))) as ScopeHashMod;
    for (const preset of ['read-only', 'write-read', 'full-access']) {
      const want = createHash('sha256')
        .update(JSON.stringify({ cap: 'permission', scope: { preset } }))
        .digest('hex');
      expect(await permissionScopeHash(preset)).toBe(want);
    }
  });

  it('不同档位摘要不同（为 A 档铸的令牌装不了 B 档）', async () => {
    const { permissionScopeHash } = (await import(/* @vite-ignore */ at('security/scope-hash.ts'))) as ScopeHashMod;
    expect(await permissionScopeHash('read-only')).not.toBe(await permissionScopeHash('full-access'));
  });
});
