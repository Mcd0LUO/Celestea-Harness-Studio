// @vitest-environment jsdom
/**
 * A3：斜杠命令 —— 补全框交互（打 / 弹出、过滤、↑↓、Enter 选中、Esc 关闭、点击选中）、
 * ! 前缀等价 /run、/run 走 api.exec（不触发 /api/turn）、/goal 设置与清除、
 * 端点缺失（404/501）给可读提示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';
// §9.2：输入栏的写入与按键都走适配缝（Lexical）；夹具见 lib/composer-dom.ts。
import { type EditorRoot, mountOn, type ComposerHandle } from './lib/composer-dom.js';

interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): { el: ElLike };
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface CmdMod {
  installCommands(): void;
  dispatchCommand(line: string, ctx?: unknown): Promise<boolean>;
  normalizeBang(line: string): string;
  isCommand(line: string): boolean;
  completionVisible(): boolean;
  activeItemLabel(): string;
}
interface SendMod { dispatchSend(text: string, mode?: string): void }

const popupRows = (): ElLike[] => Array.from(doc.querySelectorAll('#cmdPopup .cmd-row')) as ElLike[];
const popupHidden = (): boolean => (doc.getElementById('cmdPopup') as ElLike | null)?.classList.contains('hidden') ?? true;
const popupVisible = (): boolean => !popupHidden();

/** 一次真实键盘事件（Lexical 的按键链从元素上的 keydown 进，故必须带 key）。 */
function key(el: ElLike, k: string): void {
  const KB = (globalThis as unknown as { KeyboardEvent: new (t: string, i?: unknown) => unknown }).KeyboardEvent;
  el.dispatchEvent(new KB('keydown', { key: k, bubbles: true, cancelable: true }));
}

interface GoalRequest { url: string; method: string; body: Record<string, unknown> }

/**
 * W9209：这条 stub 过去对**任何**以 `/goal` 结尾的 URL 都回捏造的 200，
 * 于是 `/goal` 的后端端点根本不存在也测不出来（F-01 被它掩盖了整整一轮）。
 *
 * 现在它按**真实契约**应答（`contracts/endpoints.json#post_session_goal`，W9347 扩展 v1）：
 *   · 只认**确切路径** `/api/sessions/<id>/goal`（POST）——路径写错 = 404，
 *     而不是「只要尾巴对就成功」；
 *   · 请求体是 `{text?}` / `{paused?}`，**至少一个**；两个都给时先落 text 再落 paused；
 *   · text 空/纯空白 = 删除（回 goal:null）；paused 非 boolean = 422；
 *     **当前无目标**时 paused = 422（cannot pause: no goal）；
 *   · 200 回 `{ok,session,goal:{text,paused,createdAt,updatedAt}|null}`（paused 恒在）；
 *   · 其余一切（含未知的 /api/... 路径）如实 404 —— 绝不「什么都说成功」。
 */
function contractFetch(calls: string[], goalRequests: GoalRequest[]) {
  // 桩服务端的真源（模拟后端 sidecar）；paused 在回声里恒在。
  let stored: { text: string; paused: boolean } | null = null;
  return async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/api/exec')) return reply(200, { ok: true, exit_code: 0, signal: null, stdout: 'hi\n', stderr: '', duration_ms: 12, sandbox: { provider: 'userspace', net_isolated: true, tmp_private: true, seccomp: false } });
    if (/^\/api\/sessions\/.+\/goal$/.test(u)) {
      const method = String(init?.method ?? 'GET');
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      } catch {
        body = {};
      }
      goalRequests.push({ url: u, method, body });
      if (method !== 'POST') return reply(405, { error: 'not allowed' });
      const hasText = Object.prototype.hasOwnProperty.call(body, 'text');
      const hasPaused = Object.prototype.hasOwnProperty.call(body, 'paused');
      if (!hasText && !hasPaused) return reply(422, { ok: false, error: 'give text or paused' });
      if (hasText && typeof body['text'] !== 'string') return reply(422, { ok: false, error: "field 'text' must be a string" });
      if (hasPaused && typeof body['paused'] !== 'boolean') return reply(422, { ok: false, error: "field 'paused' must be a boolean" });
      const session = decodeURIComponent((/^\/api\/sessions\/(.+)\/goal$/.exec(u) as RegExpExecArray)[1] as string);
      // 先落 text、再落 paused（冻结契约 v1 的顺序）。
      if (hasText) {
        const text = (body['text'] as string).trim();
        stored = text === '' ? null : { text, paused: stored?.paused ?? false };
      }
      if (hasPaused && stored === null) return reply(422, { ok: false, error: 'cannot pause: no goal' });
      if (hasPaused && stored !== null) stored = { text: stored.text, paused: body['paused'] as boolean };
      const goal = stored === null
        ? null
        : { text: stored.text, paused: stored.paused, createdAt: 'a', updatedAt: 'b' };
      return reply(200, { ok: true, session, goal });
    }
    if (u.includes('/api/turn')) return reply(200, { ok: true, turn: 1 });
    return reply(404, { error: 'not found' });
  };
}

describe('A3 · 斜杠命令补全框 + 派发', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  async function boot(): Promise<{
    cmd: CmdMod;
    ctx: unknown;
    input: ElLike;
    composer: ComposerHandle;
    calls: string[];
    goalRequests: Array<{ url: string; method: string; body: Record<string, unknown> }>;
  }> {
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    const pane = ctxMod.ensurePane('ws/s1', 'session', '甲会话');
    ctxMod.activatePane('ws/s1', 'session', '甲会话');
    const calls: string[] = [];
    const goalRequests: GoalRequest[] = [];
    vi.stubGlobal('fetch', contractFetch(calls, goalRequests));
    // §9.2：installCommands 现在要读编辑器根元素（补全框锚点 + 键盘拦截口），
    //   所以输入栏必须**先**装配好；没有就现造一个（夹具自带 #input 的用原元素）。
    let input = doc.getElementById('input') as ElLike | null;
    if (!input) {
      input = doc.createElement('div') as ElLike;
      input.id = 'input';
      doc.body.appendChild(input);
    }
    const composer = await mountOn(input as unknown as EditorRoot);
    const cmd = (await import(/* @vite-ignore */ at('ui/commands/index.ts'))) as CmdMod;
    cmd.installCommands();
    return { cmd, ctx: pane, input, composer, calls, goalRequests };
  }

  it('打 / 弹出补全列表，显示名字 + 一行说明 + 参数提示', async () => {
    const { composer } = await boot();
    composer.type('/');
    await flush();
    expect(popupVisible()).toBe(true);
    const names = popupRows().map((r) => r.querySelector('.cmd-name')?.textContent);
    expect(names).toEqual(['/run', '/goal', '/model', '/compact']);
    expect(popupRows()[0]?.querySelector('.cmd-desc')?.textContent).toContain('执行');
    expect(popupRows()[0]?.querySelector('.cmd-args')?.textContent).toBe('<命令>');
  });

  it('边打边过滤；↑↓ 改高亮；Enter 选中写回输入框', async () => {
    const { input, composer } = await boot();
    composer.type('/go');
    await flush();
    expect(popupRows().map((r) => r.querySelector('.cmd-name')?.textContent)).toEqual(['/goal']);
    composer.type('/m');
    await flush();
    expect(popupRows().map((r) => r.querySelector('.cmd-name')?.textContent)).toEqual(['/model']);
    composer.type('/');
    await flush();
    key(input, 'ArrowDown');
    const cmd = (await import(/* @vite-ignore */ at('ui/commands/index.ts'))) as CmdMod;
    expect(cmd.activeItemLabel()).toBe('/goal');
    key(input, 'Enter');
    expect(input.value).toBe('/goal ');
    expect(popupHidden(), 'Enter 选中后补全框关闭').toBe(true);
  });

  it('Esc 关闭补全框（且只关这一层）', async () => {
    const { input, composer } = await boot();
    composer.type('/');
    await flush();
    expect(popupVisible()).toBe(true);
    key(input, 'Escape');
    expect(popupHidden()).toBe(true);
  });

  it('点击选中行写回输入框', async () => {
    const { input, composer } = await boot();
    composer.type('/com');
    await flush();
    const row = popupRows()[0] as ElLike;
    row.dispatchEvent(new Ev('mousedown', { bubbles: true }));
    expect(input.value).toBe('/compact '); // 选中命令后留一个空格，便于继续输入参数
  });

  it('! 前缀归一化为 /run，且不触发 /api/turn', async () => {
    const { cmd, calls } = await boot();
    expect(cmd.normalizeBang('!echo hi')).toBe('/run echo hi');
    expect(cmd.isCommand('!echo hi')).toBe(true);
    const send = (await import(/* @vite-ignore */ at('ui/send.ts'))) as SendMod;
    send.dispatchSend('!echo hi');
    await flush();
    expect(calls.some((u) => u.includes('/api/exec'))).toBe(true);
    expect(calls.some((u) => u.includes('/api/turn')), '! 命令不得触发模型轮次').toBe(false);
  });

  it('/run 走 api.exec，输出渲染成终端块（含退出码/耗时）', async () => {
    const { cmd, calls } = await boot();
    await cmd.dispatchCommand('/run echo hi');
    await flush();
    expect(calls.some((u) => u.includes('/api/exec'))).toBe(true);
    expect(calls.some((u) => u.includes('/api/turn'))).toBe(false);
    const blocks = doc.querySelectorAll('.exec-block');
    expect(blocks.length).toBe(1);
    expect(doc.querySelector('.exec-stream.out .exec-stream-body')?.textContent).toContain('hi');
    expect(doc.querySelector('.exec-code')?.textContent).toContain('退出码 0');
    expect(doc.querySelector('.exec-dur')?.textContent).toContain('12');
  });

  it('端点缺失（404）→ 可读提示，不静默', async () => {
    const { cmd } = await boot();
    vi.stubGlobal('fetch', async (url: unknown) => String(url).includes('/api/exec') ? reply(404, { error: 'not found' }) : reply(200, { ok: true }));
    await cmd.dispatchCommand('/run echo hi');
    await flush();
    expect(doc.querySelector('.exec-note')?.textContent ?? '').not.toBe('');
  });

  it('/goal 设置后浮动胶囊出现（文字可见）', async () => {
    const { cmd } = await boot();
    await cmd.dispatchCommand('/goal 把 F2 做完');
    await flush();
    const capsule = doc.querySelector('.goal-capsule');
    expect(capsule?.classList.contains('hidden')).toBe(false);
    expect(doc.querySelector('.goal-capsule .goal-capsule-text')?.textContent).toContain('把 F2 做完');
  });

  /**
   * W9209（F-01 的掩盖机制）：这条用例把上一轮审计指出的假 mock 钉死。
   * 它断言的是**请求本身与真实契约一致**（确切路径 / POST / body 形状），
   * 而不是"界面看起来对了"。若前端把路径改成契约里不存在的地址，
   * 上面那条 stub 会如实回 404 ⇒ 本用例必红。
   */
  it('/goal 打到契约里的确切端点，且请求体是 {text}（设置与清除各一次）', async () => {
    const { cmd, goalRequests } = await boot();
    await cmd.dispatchCommand('/goal 把 F2 做完');
    await flush();
    await cmd.dispatchCommand('/goal done');
    await flush();
    expect(goalRequests).toHaveLength(2);
    for (const req of goalRequests) {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/api/sessions/' + encodeURIComponent('ws/s1') + '/goal');
      expect(Object.keys(req.body)).toEqual(['text']);
    }
    expect(goalRequests[0]?.body['text']).toBe('把 F2 做完');
    // 'done' 是清除：前端必须发空串，而不是某个 "done" 字面量。
    expect(goalRequests[1]?.body['text']).toBe('');
    // 清除后胶囊消失、不占位（W9347）。
    expect(doc.querySelector('.goal-capsule')?.classList.contains('hidden')).toBe(true);
  });

  it('未知命令给可读提示（不静默、不发 turn）', async () => {
    const { cmd, calls } = await boot();
    const consumed = await cmd.dispatchCommand('/nope');
    await flush();
    expect(consumed).toBe(true);
    expect(calls.some((u) => u.includes('/api/turn'))).toBe(false);
    expect(doc.querySelector('.msg.info')?.textContent ?? '').toContain('没有这个命令');
  });
});

/**
 * 「发送前变换缝」（设计 docs/feature/composer-surface.md §2）：dispatchCommand 的
 * Promise<boolean> 从此**参与发送决策** —— 返回 false（放行）时这一行走完整正常
 * 发送路径，不再被命令分支的无条件 return 吞掉。
 *
 * 主场景只有一个：**放行的命令，那一行真的到达 host**。判据全落在后果上
 * （发了没有 / 发的什么 / 屏幕上看得见什么），不钉「怎么发的」。
 *
 * 两条临时命令（`eat` 只消费 / `reheat` 放行）走**真实注册缝**登记：被测的是
 * dispatchSend 拿到返回值之后的分派决策，不该靠改内置命令表来制造场景。
 */
describe('A3 · 发送前变换缝（放行 / 只消费 的分派决策）', () => {
  interface RegistryMod {
    registerCommand(cmd: { name: string; desc: string; args: string; run(): boolean | Promise<boolean> }): void;
  }
  interface Sent { input: string }

  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  /** 装会话 + 两条临时命令，并记录每一次 POST /api/turn 真正带出去的文本与命令被调用的名字。 */
  async function boot(): Promise<{ sent: Sent[]; ran: string[]; send: SendMod }> {
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    ctxMod.ensurePane('ws/s1', 'session', '甲会话');
    ctxMod.activatePane('ws/s1', 'session', '甲会话');
    const sent: Sent[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown }) => {
      if (String(url).includes('/api/turn')) {
        let input = '';
        try {
          input = String((JSON.parse(String(init?.body ?? '{}')) as { input?: unknown }).input ?? '');
        } catch {
          input = '<body 解析失败>';
        }
        sent.push({ input });
        return reply(200, { ok: true, turn: 1 });
      }
      return reply(200, { ok: true });
    });
    const ran: string[] = [];
    const reg = (await import(/* @vite-ignore */ at('ui/commands/registry.ts'))) as RegistryMod;
    reg.registerCommand({ name: 'eat', desc: '只消费这一行', args: '', run: () => { ran.push('eat'); return true; } });
    reg.registerCommand({ name: 'reheat', desc: '放行这一行', args: '', run: () => { ran.push('reheat'); return false; } });
    const send = (await import(/* @vite-ignore */ at('ui/send.ts'))) as SendMod;
    return { sent, ran, send };
  }

  it('放行（run 返回 false）的命令走完整正常发送路径：原样到达 host，且只发一次', async () => {
    const { sent, ran, send } = await boot();
    send.dispatchSend('/reheat 放行我');
    await flush(12);
    expect(ran, '命令本身必须真的跑了（否则这条断言会空转）').toEqual(['reheat']);
    expect(sent, '放行必须真的发出去，不能被命令分支无声吞掉').toHaveLength(1);
    // 发出去的是**闭包捕获的原值**：此刻输入框早已被 clearInput() 清空，
    // 回读输入框只会拿到空串。
    expect(sent[0]?.input).toBe('/reheat 放行我');
    expect(doc.querySelector('.msg.user .content')?.textContent).toBe('/reheat 放行我');
  });

  it('只消费（run 返回 true）的命令不发 /api/turn', async () => {
    const { sent, ran, send } = await boot();
    send.dispatchSend('/eat 别发我');
    await flush(12);
    expect(ran).toEqual(['eat']);
    expect(sent, '已消费的命令不许再走一遍正常发送').toHaveLength(0);
  });

  it('非命令行照旧同步走正常发送路径（分派改造不牵连普通发送）', async () => {
    const { sent, ran, send } = await boot();
    send.dispatchSend('普通一句话');
    await flush(12);
    expect(ran, '普通文本不经过任何命令').toEqual([]);
    expect(sent.map((s) => s.input)).toEqual(['普通一句话']);
  });
});