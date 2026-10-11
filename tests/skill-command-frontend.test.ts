// @vitest-environment jsdom
/**
 * 技能显式调用（`/{技能名}`）· 切片 2「前端接入」
 * （docs/feature/skill-command.md §4 切片 2；引擎能力消费 composer-surface 方案一）。
 *
 * 这条链路能坏的方式只有一种，且是静音的：**前端放行了、技能却没被 host 认**。
 * 所以断言全部落在**后果**上——发没发、发的什么原文、补全框长什么样、选中后草稿
 * 变成什么形状；没有一条钉「怎么发的」。
 *
 * 主场景（铁律 3，探针/断言按主场景定价）：
 *   ① 用户在输入框打 `/review …` 且清单命中 ⇒ 那一行**原样**到达 host；
 *   ② `/` 补全框里技能出现在命令组之后，选中它草稿变成规范形态 `/skill:review`。
 * 顺带钉住文档写明的三条边界：命令优先（撞名）、缓存未到按未命中处理、会话切换失效重拉。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all, at, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): unknown;
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface CmdMod {
  installCommands(): void;
  dispatchCommand(line: string, ctx?: unknown): Promise<boolean>;
}
interface SendMod { dispatchSend(text: string, mode?: string): void }
interface SkillsMod {
  refreshSkills(session: string): Promise<void>;
  isSkillGesture(line: string): boolean;
}

/** 会话 → 该会话能加载的技能（没登记的会话 = 端点 404 = 「这个端点没有这份清单」）。 */
type Listings = Record<string, Array<{ name: string; description: string }>>;

const REVIEW = { name: 'review', description: '代码评审' };
const SHIP = { name: 'ship', description: '发布收尾' };

/** 弹层里「组头 + 行」的混合序列：组头记成 #组名，行记成主文本。 */
function outline(): string[] {
  return all('#cmdPopup > *').map((n) =>
    n.className === 'cmd-group' ? '#' + (n.textContent ?? '') : (n.querySelector('.cmd-name')?.textContent ?? '?'),
  );
}

interface Booted {
  cmd: CmdMod;
  send: SendMod;
  skills: SkillsMod;
  input: ElLike;
  sent: string[];
  urls: string[];
}

/**
 * 装一条完整的输入→命令→发送链路（真实 ui/commands + ui/send）。
 * `listings` 决定技能端点的回包；`paneId` 是本次聚焦的会话。
 */
async function boot(listings: Listings, paneId = 'ws/s1'): Promise<Booted> {
  resetHarness();
  const sent: string[] = [];
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    urls.push(u);
    if (u.includes('/api/exec')) {
      return reply(200, { ok: true, exit_code: 0, signal: null, stdout: 'hi\n', stderr: '', duration_ms: 1, sandbox: { provider: 'userspace', net_isolated: true, tmp_private: true, seccomp: false } });
    }
    const m = /^\/api\/sessions\/(.+)\/skills$/.exec(u);
    if (m !== null) {
      const sid = decodeURIComponent(m[1]!);
      const rows = listings[sid];
      if (rows === undefined) return reply(404, { error: 'not found' });
      // 回体形状照 contracts 的冻结契约：四个键恒在，每行四个线上键。
      return reply(200, {
        ok: true,
        session: sid,
        skills: rows.map((r) => ({ ...r, source: 'project', dir: '/ws/.celestea/skills/' + r.name })),
        rejected: [],
      });
    }
    if (u.includes('/api/turn')) {
      let input = '';
      try {
        input = String((JSON.parse(String(init?.body ?? '{}')) as { input?: unknown }).input ?? '');
      } catch {
        input = '<body 解析失败>';
      }
      sent.push(input);
      return reply(200, { ok: true, turn: 1 });
    }
    return reply(404, { error: 'not found' });
  });
  const ctx = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
  ctx.initViewCtx();
  ctx.ensurePane(paneId, 'session', '甲会话');
  ctx.activatePane(paneId, 'session', '甲会话');
  const cmd = (await import(/* @vite-ignore */ at('ui/commands/index.ts'))) as CmdMod;
  cmd.installCommands();
  const send = (await import(/* @vite-ignore */ at('ui/send.ts'))) as SendMod;
  const skills = (await import(/* @vite-ignore */ at('ui/commands/skills.ts'))) as SkillsMod;
  return { cmd, send, skills, input: doc.getElementById('input') as ElLike, sent, urls };
}

/** 让技能清单**到位**（模拟「会话已激活、清单已拉到」的常态，而不是靠补全那次补拉）。 */
async function withSkills(b: Booted, session: string): Promise<void> {
  await b.skills.refreshSkills(session);
}

const infoText = (): string => doc.querySelector('.msg.info')?.textContent ?? '';
const userText = (): string => doc.querySelector('.msg.user .content')?.textContent ?? '';
const skillsCalls = (b: Booted): number => b.urls.filter((u) => /\/skills$/.test(u)).length;

describe('技能显式调用 · 切片 2：/ 命中清单时放行给 host', () => {
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('① 裸 /<技能> 命中清单 ⇒ 那一行原样到达 host（不改写、不拦下）', async () => {
    const b = await boot({ 'ws/s1': [REVIEW, SHIP] });
    await withSkills(b, 'ws/s1');
    b.send.dispatchSend('/review 帮我看看这个 PR');
    await flush(12);
    expect(b.sent, '技能行必须真的发出去（放行是本切片的主场景）').toEqual(['/review 帮我看看这个 PR']);
    expect(userText(), '用户气泡上是用户自己打的那一行').toBe('/review 帮我看看这个 PR');
    expect(infoText(), '放行不得同时报「没有这个命令」').not.toContain('没有这个命令');
  });

  it('② 规范形态 /skill:<名> 与裸名走**同一条**放行路径', async () => {
    const b = await boot({ 'ws/s1': [REVIEW] });
    await withSkills(b, 'ws/s1');
    b.send.dispatchSend('/skill:review 同样放行');
    await flush(12);
    expect(b.sent).toEqual(['/skill:review 同样放行']);
  });

  it('③ 两者都不是 ⇒ 照旧「没有这个命令」，且不发 /api/turn', async () => {
    const b = await boot({ 'ws/s1': [REVIEW] });
    await withSkills(b, 'ws/s1');
    const consumed = await b.cmd.dispatchCommand('/ghost');
    await flush(12);
    expect(consumed, '未命中的命令仍被消费（沿用既有行为）').toBe(true);
    expect(b.sent).toEqual([]);
    expect(infoText()).toContain('没有这个命令');
  });

  it('④ 缓存未到 ⇒ 按「未命中」处理：可见报错，绝不静默放行', async () => {
    // 这条钉的是文档写明的取舍：放行判定**只读同步缓存**，等网络会出现
    // 「输入框已清空、消息还没发出去」的间隙 ⇒ 宁可先按未命中（走既有可见报错）。
    const b = await boot({ 'ws/s1': [REVIEW] });
    b.send.dispatchSend('/review 缓存还没到');
    await flush(12);
    expect(b.sent, '缓存未到不得放行').toEqual([]);
    expect(infoText(), '缓存未到必须给看得见的反馈').toContain('没有这个命令');
  });

  it('⑤ 命令优先于同名技能（撞名）：清单里有 run 时 /run 仍是命令', async () => {
    const b = await boot({ 'ws/s1': [{ name: 'run', description: '同名技能' }] });
    await withSkills(b, 'ws/s1');
    b.send.dispatchSend('/run echo hi');
    await flush(12);
    expect(b.urls.some((u) => u.includes('/api/exec')), '撞名时命令优先，走 exec').toBe(true);
    expect(b.sent, '撞名时不得放行给 host').toEqual([]);
  });
});

describe('技能显式调用 · 切片 2：/ 补全框的技能组', () => {
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  async function openSlash(b: Booted, line: string): Promise<void> {
    b.input.value = line;
    b.input.dispatchEvent(new Ev('input', { bubbles: true }));
    await flush();
  }

  it('① 命令组在前、技能组在后；技能带一行描述', async () => {
    const b = await boot({ 'ws/s1': [REVIEW, SHIP] });
    await withSkills(b, 'ws/s1');
    await openSlash(b, '/');
    expect(outline()).toEqual([
      '#命令', '/run', '/goal', '/model', '/compact',
      '#技能', '/skill:review', '/skill:ship',
    ]);
    expect(doc.querySelectorAll('#cmdPopup .cmd-row').length, '组头不是可选项').toBe(6);
    expect(doc.querySelector('#cmdPopup .cmd-row:nth-child(7) .cmd-desc')?.textContent).toBe('代码评审');
  });

  it('② 选中技能行 ⇒ 草稿改写成规范形态 /skill:<名>', async () => {
    const b = await boot({ 'ws/s1': [REVIEW] });
    await withSkills(b, 'ws/s1');
    await openSlash(b, '/');
    const row = all('#cmdPopup .cmd-row').find(
      (r) => r.querySelector('.cmd-name')?.textContent === '/skill:review',
    ) as ElLike;
    row.dispatchEvent(new Ev('mousedown', { bubbles: true }));
    // 尾随空格是 applyCommand 对**所有**项统一加的参数分隔位（同 /run），
    // 规范形态指的是那个 token 本身——用户一眼能看出自己落在技能命名空间。
    expect(b.input.value).toBe('/skill:review ');
    expect(b.input.value.startsWith('/review'), '不得回写成裸名').toBe(false);
  });

  it('③ 会话切换 ⇒ 清单失效重拉，旧会话的技能对新会话不算数', async () => {
    const b = await boot({ 'ws/s1': [REVIEW], 'ws/s2': [SHIP] });
    await withSkills(b, 'ws/s1');
    expect(b.skills.isSkillGesture('/review')).toBe(true);
    const ctx = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctx.ensurePane('ws/s2', 'session', '乙会话');
    ctx.activatePane('ws/s2', 'session', '乙会话');
    await flush(8);
    expect(b.skills.isSkillGesture('/review'), '旧会话的技能对新会话一律不算数').toBe(false);
    expect(b.skills.isSkillGesture('/ship')).toBe(true);
  });

  it('④ 缓存为空时打开补全会异步补拉一次（不是每敲一个键打一次）', async () => {
    const b = await boot({ 'ws/s1': [REVIEW] });
    await openSlash(b, '/');
    expect(skillsCalls(b), '首次打开补全即触发一次清单').toBe(1);
    await openSlash(b, '/r');
    expect(skillsCalls(b), '缓存已到就不再打端点').toBe(1);
  });
});
describe('技能显式调用 · 注入行的呈现（origin=skill-invocation）', () => {
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  interface UserMod {
    renderInboxMessage(
      ctx: unknown,
      text: string,
      opts?: { source?: string; kind?: string },
    ): ElLike;
  }

  /** 真实 renderInboxMessage + 真实 i18n（默认中文）。 */
  async function render(kind: string, text: string): Promise<ElLike> {
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    const pane = ctxMod.ensurePane('ws/s1', 'session', '甲会话');
    const userMod = (await import(/* @vite-ignore */ at('ui/messages/user.ts'))) as UserMod;
    return userMod.renderInboxMessage(pane, text, { kind, source: '技能调用' });
  }

  /** 折叠态：<details> 的 open 属性（true = 展开）。 */
  const isOpen = (col: ElLike): boolean => (col.querySelector('.inbox-fold') as unknown as { open: boolean }).open;

  it('注入行渲染成带标题的 inbox 块，且与「技能目录」是两种不同的块', async () => {
    const col = await render('skill-invocation', '<skill_content name="review">正文</skill_content>');
    // 后果一：它**不是**回退分支（回退分支没有折叠头，标题是拼出来的「回执 · …」）。
    expect(col.querySelector('.inbox-fold-title')?.textContent).toBe('技能调用');
    expect(col.textContent).toContain('<skill_content name="review">');
    // 后果二：与技能目录（origin=skill）分得开 —— 两块标签不同、默认态不同。
    const cat = await render('skill', '每轮注入的技能目录');
    expect(cat.querySelector('.inbox-fold-title')?.textContent).toBe('技能目录');
    expect(isOpen(cat), '技能目录是每轮背景，默认折叠').toBe(false);
    expect(isOpen(col), '技能调用是一次性事件（且失败行同源），默认展开').toBe(true);
  });
});