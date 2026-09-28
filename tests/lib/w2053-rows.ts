// ============================================================================
// tests/lib/w2053-rows.ts — W2053 前端键盘用例的**共用夹具**（jsdom）。
//
// 为什么要单独一个文件：本仓 eslint 对 tests/** 有单文件 400 行、单函数 80 行的硬上限，
// 而 W2053 的接线断言横跨 5 处位点（会话树叶子 / worker 行 / 分组头 / 目录弹层 /
// 提供商表行）。夹具抽出来后每个文件各管一组位点，规模自然落在上限内。
//
// 这里只放**机制**（fetch 打桩、键盘事件、行查询助手、会话树/提供商表的启动），
// 不放任何断言 —— 断言全部留在 *.test.ts 里（与 tests/lib/w795-dom.ts 同一条纪律）。
// ============================================================================
import { vi } from 'vitest';
import { at, doc, flush, reply, type ElLike } from './w795-dom.js';

export interface El extends ElLike {
  tabIndex: number;
  focus(): void;
  closest(sel: string): El | null;
  contains(n: unknown): boolean;
  hasAttribute(n: string): boolean;
}

/**
 * 带 activeElement 的 document 视图。
 *
 * 为什么需要：tests/lib/w795-dom.ts 的 DocLike 只声明了它自己用到的形状，没有
 * activeElement。W2053 要用它证明「焦点真的落在新清单的第一行」，所以在这里补一个
 * **窄**的类型视图 —— 不去改共用夹具（那是别人领地，且改动面远大于本遍需要）。
 */
export const activeEl = (): El | null =>
  (doc as unknown as { activeElement: El | null }).activeElement;

export const q = (sel: string): El | null => doc.querySelector(sel) as unknown as El | null;
export const qa = (sel: string): El[] => Array.from(doc.querySelectorAll(sel) as unknown as ArrayLike<El>);

/** 派发一次可取消的 keydown（真机上由浏览器产生；jsdom 里手工构造）。 */
export const keyOn = (n: El, key: string, init: Record<string, unknown> = {}): void => {
  const ev = new (globalThis as unknown as { KeyboardEvent: new (t: string, i?: unknown) => unknown }).KeyboardEvent(
    'keydown', { key, bubbles: true, cancelable: true, ...init },
  );
  n.dispatchEvent(ev);
};

/** roving 标记选择器（与 ui/roving.ts 的 ROVING_ROW 同一份口径）。 */
export const ROVING = '[data-roving]';

/** 某个容器里**进 Tab 序列**的 roving 行（tabindex=0 的那个，roving 下应恒为 1 个）。 */
export const stopsIn = (sel: string): El[] =>
  qa(sel + ' ' + ROVING).filter((n) => n.getAttribute('tabindex') === '0');

/** 会话夹具：一个工作区、三个会话（顺序即文档序）。 */
export const SESSIONS = [
  { id: 'ws/s1', title: '甲', workspace: 'ws', modified: 3 },
  { id: 'ws/s2', title: '乙', workspace: 'ws', modified: 2 },
  { id: 'ws/s3', title: '丙', workspace: 'ws', modified: 1 },
];

/**
 * 打桩 fetch：extra 先有机会接管某个 URL（返回 undefined = 不接管），
 * 其余落回「一个工作区 + SESSIONS」的默认事实。
 */
export function installFetch(extra: (u: string, method: string) => unknown | undefined): void {
  vi.stubGlobal('fetch', async (url: unknown, init?: { method?: string }) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const hit = extra(u, method);
    if (hit !== undefined) return hit;
    if (u === '/api/workspaces' || u.startsWith('/api/workspaces?')) {
      return reply(200, { ok: true, workspaces: [{ name: 'ws' }], active_session: null });
    }
    if (method === 'GET' && (u === '/api/sessions' || u.startsWith('/api/sessions?'))) {
      return reply(200, { ok: true, sessions: SESSIONS });
    }
    return reply(200, { ok: true });
  });
}

/** 载入真实会话树（ui/sessions.ts 的 loadSessions）。 */
export async function loadSessionsTree(): Promise<void> {
  const mod = (await import(/* @vite-ignore */ at('ui/sessions.ts'))) as { loadSessions(): Promise<void> };
  await mod.loadSessions();
  await flush();
}

/** 等一次异步导航（fsbrowser 的 loadDirs 是 async，且经 fetch 打桩）。 */
export async function settle(): Promise<void> {
  await flush();
  await new Promise((r) => setTimeout(r, 20));
  await flush();
}

/** 开一个目录浏览弹层（走真实 openFsBrowser）。 */
export async function openBrowser(): Promise<void> {
  const mod = (await import(/* @vite-ignore */ at('ui/fsbrowser.ts'))) as {
    openFsBrowser(o: { title: string; confirmLabel: string; busyLabel: string; onPick: () => void }): void;
  };
  mod.openFsBrowser({ title: '选择目录', confirmLabel: '确定', busyLabel: '处理中', onPick: () => {} });
  await settle();
}

/**
 * 挂上提供商 pane 的最小宿主并载入列表。
 * providers/state.ts 在 import 期 need('#settingsProviders')，宿主必须在位。
 */
export async function loadProviders(providers: readonly unknown[]): Promise<void> {
  const page = doc.createElement('div');
  page.id = 'settingsPage';
  const pane = doc.createElement('section');
  pane.className = 'settings-pane';
  pane.setAttribute('data-pane', 'providers');
  const host = doc.createElement('div');
  host.id = 'settingsProviders';
  pane.appendChild(host);
  page.appendChild(pane);
  doc.body.appendChild(page);
  installFetch((u) => (u === '/api/providers' ? reply(200, { providers, default_model: null }) : undefined));
  const mod = (await import(/* @vite-ignore */ at('ui/providers.ts'))) as { loadProviders(): Promise<void> };
  await mod.loadProviders();
  await flush();
}
