// @vitest-environment jsdom
/**
 * D1 · `/mcp:<server>` 的**前端发送路径**（docs/feature/mcp-client.md §5.6、
 * A4b 留下的那一半：「补全框与 chip 已就位，但 dispatchCommand 仍报没有这个命令」）。
 *
 * 主场景（铁律 3）：
 *   ① 人打 `/mcp:<server>`（含第二层 `/mcp:<server>/<tool>`）⇒ 那一行**原样**到达
 *      host，不被当作命令消费，也不报「没有这个命令」；
 *   ② **裸 `/<server名>` 永不代表 MCP**（D9 字符串契约）⇒ 照旧走既有的未知命令提示。
 * 顺带钉住一条容易被写坏的边界：前端**不查清单**（同一个字符串指什么不随装了什么变化，
 * 裁决在 host），所以清单里没有的 `/mcp:ghost` 也照样放行。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { at, doc, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';
import { type EditorRoot, mountOn, type ComposerHandle } from './lib/composer-dom.js';

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
interface SkillsMod { refreshSkills(session: string): Promise<void>; isSkillGesture(line: string): boolean }
interface McpMod {
  refreshMcpServers(): Promise<void>;
  cachedMcpServers(): readonly { server: string; state: string; toolCount: number }[];
  isMcpGesture(line: string): boolean;
}

const MEMORY = { server: 'memory', transport: 'stdio', state: 'ready', toolCount: 2 };

interface Booted {
  cmd: CmdMod;
  send: SendMod;
  skills: SkillsMod;
  mcp: McpMod;
  input: ElLike;
  composer: ComposerHandle;
  sent: string[];
}

/** 装一条完整的输入→命令→发送链路；`servers` 决定 `GET /api/plugins` 报的 MCP 清单。 */
async function boot(servers: Array<typeof MEMORY> = [MEMORY]): Promise<Booted> {
  resetHarness();
  const sent: string[] = [];
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.includes('/api/exec')) {
      return reply(200, { ok: true, exit_code: 0, signal: null, stdout: 'hi\n', stderr: '', duration_ms: 1, sandbox: { provider: 'userspace', net_isolated: true, tmp_private: true, seccomp: false } });
    }
    if (u.includes('/api/plugins')) {
      return reply(200, { ok: true, plugins: [{ id: 'studio.engine.mcp', mcp: { rows: servers, servers: servers.length, tools: 2, state: 'ready' } }] });
    }
    const skills = /^\/api\/sessions\/(.+)\/skills$/.exec(u);
    if (skills !== null) {
      return reply(200, { ok: true, session: decodeURIComponent(skills[1]!), skills: [], rejected: [] });
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
  ctx.ensurePane('ws/s1', 'session', '甲会话');
  ctx.activatePane('ws/s1', 'session', '甲会话');
  let input = doc.getElementById('input') as ElLike | null;
  if (!input) {
    input = doc.createElement('div') as ElLike;
    input.id = 'input';
    doc.body.appendChild(input);
  }
  const composer = await mountOn(input as unknown as EditorRoot);
  const cmd = (await import(/* @vite-ignore */ at('ui/commands/index.ts'))) as CmdMod;
  cmd.installCommands();
  const send = (await import(/* @vite-ignore */ at('ui/send.ts'))) as SendMod;
  const skills = (await import(/* @vite-ignore */ at('ui/commands/skills.ts'))) as SkillsMod;
  const mcp = (await import(/* @vite-ignore */ at('ui/commands/mcp.ts'))) as McpMod;
  return { cmd, send, skills, mcp, input, composer, sent };
}

const infoText = (): string => doc.querySelector('.msg.info')?.textContent ?? '';
const userText = (): string => doc.querySelector('.msg.user .content')?.textContent ?? '';

describe('D1 · /mcp:<server> 在 dispatchCommand 里不被消费（放行给 host）', () => {
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('① 规范形态 ⇒ 那一行原样到达 host，且不报「没有这个命令」', async () => {
    const b = await boot();
    await b.mcp.refreshMcpServers();
    b.send.dispatchSend('/mcp:memory 记住这条');
    await flush(12);
    expect(b.sent, '放行是本任务的主场景：MCP 手势必须真的发出去').toEqual(['/mcp:memory 记住这条']);
    expect(userText(), '用户气泡上是用户自己打的那一行（host 只剥 token，不改写其余）').toBe('/mcp:memory 记住这条');
    expect(infoText(), '不得同时报「没有这个命令」').not.toContain('没有这个命令');
  });

  it('② 第二层 /mcp:<server>/<tool> 走**同一条**放行路径（不是两条分叉）', async () => {
    const b = await boot();
    await b.mcp.refreshMcpServers();
    b.send.dispatchSend('/mcp:memory/create_entities 建一个节点');
    await flush(12);
    expect(b.sent).toEqual(['/mcp:memory/create_entities 建一个节点']);
    expect(infoText()).not.toContain('没有这个命令');
  });

  it('③ dispatchCommand 直接调用时同样返回 false（未被消费）', async () => {
    const b = await boot();
    await b.mcp.refreshMcpServers();
    expect(await b.cmd.dispatchCommand('/mcp:memory')).toBe(false);
    expect(await b.cmd.dispatchCommand('/mcp:memory/search_nodes 找一下')).toBe(false);
  });

  it('④ 清单里没有的 server 也放行：同一个字符串指什么**不随装了什么变化**，裁决在 host', async () => {
    const b = await boot([MEMORY]);
    await b.mcp.refreshMcpServers();
    b.send.dispatchSend('/mcp:ghost 干活');
    await flush(12);
    expect(b.sent, '前端不查清单（否则「缓存还没到」会变成一次假否决）').toEqual(['/mcp:ghost 干活']);
  });
});

describe('D1 · 裸 /<server名> 永不代表 MCP（D9 字符串契约）', () => {
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('① 清单里正好有 memory 时，/memory 仍是「没有这个命令」而不是 MCP 手势', async () => {
    const b = await boot([MEMORY]);
    await b.mcp.refreshMcpServers();
    expect(b.mcp.cachedMcpServers().map((s) => s.server), '前提：清单确实到位了').toEqual(['memory']);
    expect(b.mcp.isMcpGesture('/memory')).toBe(false);
    const consumed = await b.cmd.dispatchCommand('/memory');
    await flush(12);
    expect(consumed, '裸名照旧被消费（既有行为不变）').toBe(true);
    expect(b.sent).toEqual([]);
    expect(infoText()).toContain('没有这个命令');
  });

  it('② isMcpGesture 只认 /mcp: 前缀这一种形态（第二层也算）', async () => {
    const b = await boot();
    for (const line of ['/mcp:memory', '/mcp:memory/create_entities 干活', '/mcp:memory 干活']) {
      expect(b.mcp.isMcpGesture(line), line).toBe(true);
    }
    for (const line of ['/memory', '/memory/create_entities', '/skill:memory', '/help', 'mcp:memory', '/mcp:', '普通文字']) {
      expect(b.mcp.isMcpGesture(line), line).toBe(false);
    }
  });

  it('③ 技能手势不受影响（/review 仍由技能那条放行）', async () => {
    const b = await boot();
    expect(b.skills.isSkillGesture('/memory')).toBe(false);
    expect(b.mcp.isMcpGesture('/review')).toBe(false);
  });
});

describe('D1 · origin=mcp-invocation 的注入行呈现', () => {
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  interface UserMod {
    renderInboxMessage(ctx: unknown, text: string, opts?: { source?: string; kind?: string }): ElLike;
  }

  async function render(kind: string, text: string): Promise<ElLike> {
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    const pane = ctxMod.ensurePane('ws/s1', 'session', '甲会话');
    const userMod = (await import(/* @vite-ignore */ at('ui/messages/user.ts'))) as UserMod;
    return userMod.renderInboxMessage(pane, text, { kind, source: 'MCP 调用' });
  }

  const isOpen = (col: ElLike): boolean => (col.querySelector('.inbox-fold') as unknown as { open: boolean }).open;

  it('注入行渲染成带标题的 inbox 块，且与「技能目录」/「技能调用」是三种不同的块', async () => {
    const col = await render('mcp-invocation', '<mcp_catalog server="memory" tools="2">…</mcp_catalog>');
    expect(col.querySelector('.inbox-fold-title')?.textContent).toBe('MCP 调用');
    expect(col.textContent).toContain('<mcp_catalog server="memory"');
    // 默认展开：失败行同源，折起来就等于把「没注上」藏起来（§5.6 降级纪律）。
    expect(isOpen(col), 'MCP 调用是一次性事件（且失败行同源），默认展开').toBe(true);
    const skill = await render('skill-invocation', '<skill_content name="review">正文</skill_content>');
    expect(skill.querySelector('.inbox-fold-title')?.textContent).toBe('技能调用');
    const cat = await render('skill', '每轮注入的技能目录');
    expect(cat.querySelector('.inbox-fold-title')?.textContent).toBe('技能目录');
    expect(isOpen(cat), '技能目录是每轮背景，默认折叠').toBe(false);
  });
});
