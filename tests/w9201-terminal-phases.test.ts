// @vitest-environment jsdom
// ============================================================================
// tests/w9201-terminal-phases.test.ts — W9201（P1）终态 phase 集合的机械门禁。
//
// 缺陷：chat.ts 的 onStatus 手写 `completed || cancelled || error` 三个字面量，
// 而契约 contracts/sse-events.json 里 status 事件的 status.phase 字段枚举有 **5 个**终态：
//   completed | cancelled | error | step_limit | interrupted
// ⇒ step_limit（步数预算耗尽）与 interrupted（流被撕断）到达时**不调 finalizeTurn**：
//   ctx.streaming 永远为 true、assistant 气泡永远停在 streaming、输入栏永远「插话」
//   —— 会话界面永久卡在「运行中」，只能刷新或等下一条 status:start 脱困。
//
// 本文件两层（缺一层就守不住）：
//   ① **契约对拍**：chat.ts 导出的 TERMINAL_PHASES 必须逐字等于契约里的终态集合。
//      这一层是「以契约为准」的机械保证 —— 契约新增终态时这里必须红。
//   ② **行为**：走真实 chat.ts 的 onStatus，断言每个终态都真的收尾（streaming=false）。
//
// 变异负控制（改坏必红，逐条实测见 results/W9201-修复.md）：
//   · onStatus 的 isTerminalPhase(p.phase) 改回三个字面量 → ② 的 step_limit/interrupted 红；
//   · TERMINAL_PHASES 删掉 'step_limit' → ① 红。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness, type ElLike } from './lib/w795-dom.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): Pane;
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface Pane { el: ElLike; streaming: boolean; assistant: unknown; phase: string }
interface ChatMod {
  onStatus(ctx: unknown, p: Record<string, unknown>): void;
  TERMINAL_PHASES: readonly string[];
  isTerminalPhase(phase: unknown): boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** 契约里的终态集合（唯一真源 = contracts/sse-events.json，**不手写**）。 */
function contractTerminalPhases(): string[] {
  const file = join(HERE, '..', 'contracts', 'sse-events.json');
  const doc0 = JSON.parse(readFileSync(file, 'utf8')) as {
    events: { name: string; payload: Record<string, string> }[];
  };
  const status = doc0.events.find((e) => e.name === 'status');
  if (!status) throw new Error('contracts/sse-events.json: status event missing');
  const enumText = status.payload['phase'] ?? '';
  const all = [...enumText.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
  if (all.length === 0) throw new Error('contracts/sse-events.json: status.phase enum not parsed');
  return all;
}

/** 契约里的**非终态** phase（start/progress/lagged/fallback 之类）。 */
const NON_TERMINAL = ['start', 'progress', 'lagged', 'fallback'];

describe('W9201 · ① TERMINAL_PHASES 必须与契约逐字一致', () => {
  // ★ 必须先装骨架再 import chat.ts：chat.ts 顶层 import statusline.ts，
  //   它的模块级单例构造器会 needCell('#slTps') —— 骨架没装就抛「missing element」。
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('契约 status.phase 的枚举 = 终态集合 ∪ 非终态集合（无遗漏、无多余）', async () => {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    const chat = (await import(/* @vite-ignore */ at('chat.ts'))) as ChatMod;
    const contract = contractTerminalPhases();
    // 契约里的每个 phase 要么是终态、要么是已知非终态 —— 不许有第三个类别。
    const covered = [...chat.TERMINAL_PHASES, ...NON_TERMINAL].sort();
    expect(covered, '契约 phase 枚举必须被 TERMINAL_PHASES ∪ NON_TERMINAL 完整覆盖').toEqual([...contract].sort());
    // 逐个点名（失败时比 set 相等更好读）。
    expect([...chat.TERMINAL_PHASES].sort()).toEqual(['cancelled', 'completed', 'error', 'interrupted', 'step_limit']);
  });

  it('isTerminalPhase：五个终态为真，非终态为假', async () => {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    const chat = (await import(/* @vite-ignore */ at('chat.ts'))) as ChatMod;
    for (const p of chat.TERMINAL_PHASES) expect(chat.isTerminalPhase(p), p).toBe(true);
    for (const p of NON_TERMINAL) expect(chat.isTerminalPhase(p), p).toBe(false);
    expect(chat.isTerminalPhase(undefined)).toBe(false);
  });
});

describe('W9201 · ② 每个终态都真的收尾（走真实 onStatus）', () => {
  beforeEach(() => { resetHarness(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  async function boot(): Promise<{ chat: ChatMod; pane: Pane }> {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    const pane = ctxMod.ensurePane('ws/term', 'session', '甲会话');
    ctxMod.activatePane('ws/term', 'session', '甲会话');
    const chat = (await import(/* @vite-ignore */ at('chat.ts'))) as ChatMod;
    return { chat, pane };
  }

  /** 开一轮（status:start 会把 streaming 置真）。 */
  function startTurn(chat: ChatMod, pane: Pane): void {
    chat.onStatus(pane, { phase: 'start', turn: 1, statusline: {} });
    expect(pane.streaming, '前提：start 之后必须在跑').toBe(true);
  }

  for (const phase of ['completed', 'cancelled', 'error', 'step_limit', 'interrupted']) {
    it('phase=' + phase + ' → streaming 必须落回 false', async () => {
      const { chat, pane } = await boot();
      startTurn(chat, pane);
      chat.onStatus(pane, { phase, turn: 1, statusline: {} });
      // ★ 主断言：改动前 step_limit / interrupted 在这里是 true（永久卡「运行中」）。
      expect(pane.streaming, phase + ' 必须收尾').toBe(false);
    });
  }

  it('非终态（progress / lagged / fallback）不得把运行中的会话收尾', async () => {
    const { chat, pane } = await boot();
    startTurn(chat, pane);
    for (const phase of ['progress', 'lagged', 'fallback']) {
      chat.onStatus(pane, { phase, turn: 1, statusline: {} });
      expect(pane.streaming, phase + ' 不是终态，不得收尾').toBe(true);
    }
  });

  /**
   * ★ W9397：终态还要收掉**仍在运行**的工具卡。
   *
   * 掐断 / 中断的轮次不会给在飞的调用补结果，而 live 侧原先只有 applyToolResult 会摘掉
   * `.running`（重放路径另有「有调用无结果」的兜底）⇒ 卡片一直转圈到刷新为止。
   */
  it('W9397：终态 ⇒ 仍在运行的卡被收成「无结果」（与重放同文案，不留下永远转圈的卡）', async () => {
    const { chat, pane } = await boot();
    startTurn(chat, pane);
    const T = (await import(/* @vite-ignore */ at('ui/toolcards.ts'))) as unknown as {
      pushToolCard(ctx: unknown, p: Record<string, unknown>): unknown;
    };
    T.pushToolCard(pane, { id: 'c1', name: 'run_code', args: {} });
    const card = (pane.el as ElLike).querySelector('.toolcard') as ElLike;
    expect(card.classList.contains('running'), '前提：结果还没回来').toBe(true);
    chat.onStatus(pane, { phase: 'cancelled', turn: 1, statusline: {} });
    expect(card.classList.contains('running'), '终态后不得再转圈').toBe(false);
    expect(card.classList.contains('ok'), '收成终态而不是失败态').toBe(true);
    // 结果正文与重放路径**同一真源**（shell.restore.noResult）—— W895-R 的实时/重放一致：
    // 重放侧对「有调用无结果」的卡走的是同一个 setToolResult + 同一句文案。
    // （状态 pill 的文案由 setToolResult 统一写死，两条路径因此天然同字，不在这里复述。）
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as { t(k: string): string };
    expect((card.querySelector('.tool-out') as ElLike).textContent).toBe(i18n.t('shell.restore.noResult'));
  });
});
