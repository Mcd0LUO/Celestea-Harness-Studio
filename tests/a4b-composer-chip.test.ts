// @vitest-environment jsdom
/**
 * A4b · composer-surface §8 的 **chip**（Lexical decorator node）：插入 / 原子删除 /
 * 规范投影 / 草稿往返 / 失配降级（E5）+ §7 的 `/mcp:` 第三种 kind。
 *
 * 主场景（铁律 3，断言按主场景定价）：
 *   ① 用户从补全框选中 `/run` · `/skill:review` · `/mcp:memory` · `@文件` ⇒ 输入框里
 *      出现**一个 chip 药丸**，而发送出去的文本是**规范形态**（chip 的投影）。
 *   ② Backspace 触及 chip = **整体删除**，不留 `skill:rev` 残肢。
 * 顺带钉住 E3 的纪律②（chip 进冻结注册表 ⇒ 旧草稿按纪律③降级纯文本）与 E5
 * （技能被删 / server 下线 ⇒ 显示降级为普通文本，**投影一字不变**）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { all, at, doc, Ev, flush, reply, resetHarness, WEB, type ElLike } from './lib/w795-dom.js';
import { type EditorRoot, mountOn, type ComposerHandle } from './lib/composer-dom.js';

interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): unknown;
  activatePane(id: string, kind?: string, title?: string): unknown;
  setPaneMeta(id: string, meta: { workspace?: string }): void;
}
interface CmdMod {
  installCommands(): void;
  completionVisible(): boolean;
  activeItemLabel(): string;
}
interface SkillsMod { refreshSkills(session: string): Promise<void>; skillNames(): readonly string[] }
interface McpMod {
  refreshMcpServers(): Promise<void>;
  mcpServerNames(): readonly string[];
  mcpCached(): boolean;
}
interface ComposerMod {
  canonicalText(): string;
  textBeforeCaret(): string;
  setComposerText(t: string): void;
  insertComposerChip(r: { kind: string; name: string; start: number; end: number; trailing: string }): boolean;
  refreshComposerChips(fn: (kind: string, name: string) => boolean): boolean;
  draftPayload(): string;
  restoreDraftPayload(p: string): 'state' | 'text' | 'empty';
  resetComposer(): void;
}

const REVIEW = { name: 'review', description: '代码评审' };

/** 输入栏样式的真源（styles/composer.css）：chip 长什么样由它说了算。 */
const chipCss = (): string => readFileSync(join(WEB, 'src', 'styles', 'composer.css'), 'utf8');

/** 输入栏里的 chip 元素（DOM 上的那层断言：药丸真的画出来了）。 */
const chips = (): ElLike[] => all('#input .composer-chip');
/** chip 上的 kind / 名字（DOM 侧的可读标记，测试据此区分四种形态）。 */
const chipAttrs = (): Array<{ kind: string; name: string; stale: boolean }> =>
  chips().map((c) => ({
    kind: c.getAttribute('data-chip-kind') ?? '',
    name: c.getAttribute('data-chip-name') ?? '',
    stale: (c.className ?? '').includes('composer-chip-stale'),
  }));

interface Booted {
  cmd: CmdMod;
  input: ElLike;
  composer: ComposerHandle;
  c: ComposerMod;
  skills: SkillsMod;
  mcp: McpMod;
  urls: string[];
  sent: string[];
}

/** server 清单的回包（形状照 mcp-status.ts 的 McpCatalogStatus）。 */
const pluginsResp = (servers: Array<{ server: string; state?: string; toolCount?: number }>): unknown => ({
  ok: true,
  plugins: [
    { name: 'studio/bus', layer: 'host', enabled: true },
    {
      name: 'studio.engine.mcp',
      layer: 'engine',
      enabled: true,
      mcp: {
        sessions: 1,
        servers: servers.length,
        tools: servers.reduce((n, s) => n + (s.toolCount ?? 0), 0),
        state: servers.some((s) => (s.state ?? 'ready') !== 'ready') ? 'failed' : 'ready',
        error: null,
        issues: [],
        rows: servers.map((s) => ({
          server: s.server,
          session: 'ws/s1',
          transport: 'stdio',
          state: s.state ?? 'ready',
          toolCount: s.toolCount ?? 0,
        })),
      },
    },
  ],
  disabled: [],
  warnings: [],
});

async function boot(
  opts: {
    skills?: Array<{ name: string; description: string }>;
    skillsBySession?: Record<string, Array<{ name: string; description: string }>>;
    servers?: Array<{ server: string; state?: string; toolCount?: number }>;
    workspace?: boolean;
  } = {},
): Promise<Booted> {
  resetHarness();
  const urls: string[] = [];
  const sent: string[] = [];
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    urls.push(u);
    if (u.includes('/api/plugins')) return reply(200, pluginsResp(opts.servers ?? []));
    const m = /^\/api\/sessions\/(.+)\/skills$/.exec(u);
    if (m !== null) {
      const sid = decodeURIComponent(m[1]!);
      // 每个会话一份清单（模拟「切了会话、那个工作区里没有这个技能」）。
      const rows = opts.skillsBySession?.[sid] ?? opts.skills ?? [];
      return reply(200, {
        ok: true,
        session: sid,
        skills: rows.map((r) => ({ ...r, source: 'project', dir: '/ws/.celestea/skills/' + r.name })),
        rejected: [],
      });
    }
    if (u.includes('/api/turn')) {
      sent.push(String((JSON.parse(String(init?.body ?? '{}')) as { input?: string }).input ?? ''));
      return reply(200, { ok: true, turn: 1 });
    }
    return reply(200, { ok: true });
  });
  const ctx = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
  ctx.initViewCtx();
  ctx.ensurePane('ws/s1', 'session', '甲会话');
  ctx.activatePane('ws/s1', 'session', '甲会话');
  if (opts.workspace === true) {
    ctx.setPaneMeta('ws/s1', { workspace: 'celestea_studio-ts' });
    const store = (await import(/* @vite-ignore */ at('ui/sessiontree/store.ts'))) as { setWsList(v: unknown[]): void };
    store.setWsList([{ name: 'celestea_studio-ts', path: '/srv/celestea/studio' }]);
  }
  let input = doc.getElementById('input') as ElLike | null;
  if (!input) {
    input = doc.createElement('div') as ElLike;
    input.id = 'input';
    doc.body.appendChild(input);
  }
  const composer = await mountOn(input as unknown as EditorRoot);
  const cmd = (await import(/* @vite-ignore */ at('ui/commands/index.ts'))) as CmdMod;
  cmd.installCommands();
  const c = (await import(/* @vite-ignore */ at('ui/composer/index.ts'))) as ComposerMod;
  const skills = (await import(/* @vite-ignore */ at('ui/commands/skills.ts'))) as SkillsMod;
  const mcp = (await import(/* @vite-ignore */ at('ui/commands/mcp.ts'))) as McpMod;
  return { cmd, input, composer, c, skills, mcp, urls, sent };
}

/** 打开补全框并选中 label 匹配的那一行（走真实 mousedown → choose → onPick 路径）。 */
async function pickBy(b: Booted, label: string): Promise<void> {
  await flush();
  const row = all('#cmdPopup .cmd-row').find(
    (r) => r.querySelector('.cmd-name')?.textContent === label,
  ) as ElLike | undefined;
  if (row === undefined) throw new Error('补全框里没有这一行：' + label);
  row.dispatchEvent(new Ev('mousedown', { bubbles: true }));
  await flush();
}

/** 让两份清单都到位（模拟「会话已激活、清单已拉到」的常态）。 */
async function withLists(b: Booted): Promise<void> {
  await b.skills.refreshSkills('ws/s1');
  await b.mcp.refreshMcpServers();
  await flush();
}

/** 打一行文本并等补全刷新（§9.2：编辑器不发原生 input 事件，走适配缝的 onChange）。 */
async function type(b: Booted, line: string): Promise<void> {
  b.composer.type(line);
  await flush();
}

beforeEach(() => {
  resetHarness();
});
afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
  vi.resetModules();
});

// ───────────────── ① 插入：四种 chip 的插入 + 规范投影 ─────────────────
describe('A4b · chip 插入（补全框选中 → Lexical 里的一个药丸）', () => {
  it('① 命令 chip：选中 /run ⇒ 输入框里一个 chip，投影仍是 /run', async () => {
    const b = await boot();
    await type(b, '/run');
    await pickBy(b, '/run');
    expect(chipAttrs(), '输入框里必须真的有一个 chip 节点').toEqual([
      { kind: 'command', name: 'run', stale: false },
    ]);
    expect(b.c.canonicalText(), '★ 投影 = 规范形态（尾部空格沿用既有行为）').toBe('/run ');
  });

  it('② 技能 chip：选中 /skill:review ⇒ 投影是规范形态，不是裸名', async () => {
    const b = await boot({ skills: [REVIEW] });
    await withLists(b);
    await type(b, '/skill:review');
    await pickBy(b, '/skill:review');
    expect(chipAttrs()).toEqual([{ kind: 'skill', name: 'review', stale: false }]);
    expect(b.c.canonicalText(), '★ chip 的文本投影就是规范形态').toBe('/skill:review ');
    expect(b.c.canonicalText().startsWith('/review'), '不得回写成裸名').toBe(false);
  });

  it('③ MCP chip：/mcp:memory 来自 GET /api/plugins 的 mcp 清单，显示与写回都是规范形态', async () => {
    const b = await boot({ servers: [{ server: 'memory', toolCount: 2 }] });
    await withLists(b);
    await type(b, '/mcp:mem');
    await pickBy(b, '/mcp:memory');
    expect(b.urls.some((u) => u.includes('/api/plugins')), '清单只来自那一个端点').toBe(true);
    expect(chipAttrs()).toEqual([{ kind: 'mcp', name: 'memory', stale: false }]);
    expect(b.c.canonicalText()).toBe('/mcp:memory ');
  });

  it('④ @文件 chip：选中文件 ⇒ 一个 mention chip，投影就是 @路径（只传路径）', async () => {
    const b = await boot({ workspace: true });
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/fs/list')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        return reply(200, {
          path: p,
          parent: '/',
          entries: [{ name: 'README.md', type: 'file', size: 2048, mtime: null }],
          roots: [],
          truncated: false,
        });
      }
      return reply(200, { ok: true });
    });
    await type(b, '@RE');
    await pickBy(b, 'README.md');
    expect(chipAttrs()).toEqual([{ kind: 'mention', name: 'README.md', stale: false }]);
    expect(b.c.canonicalText(), '★ @提及只传路径').toBe('@README.md');
  });

  it('⑤ chip 与普通文本混排：投影按顺序拼接，且光标前文本跨过 chip 仍完整', async () => {
    const b = await boot({ skills: [REVIEW] });
    await withLists(b);
    // 先打普通文字，再把 chip 插到它前面 ⇒ 段落里是 [chip][文本] 两段。
    // （反过来用 setText 追加是不行的：它是**纯文本重建**，按设计会把 chip 拍平。）
    b.composer.type('帮我看看');
    await flush();
    b.c.insertComposerChip({ kind: 'skill', name: 'review', start: 0, end: 0, trailing: '' });
    await flush();
    expect(chipAttrs()).toEqual([{ kind: 'skill', name: 'review', stale: false }]);
    expect(b.c.canonicalText(), '投影按顺序拼接').toBe('/skill:review帮我看看');
    expect(b.c.textBeforeCaret(), '★ 光标前文本必须跨过 chip 累计（否则补全起点算错）').toBe('/skill:review');
  });

  it('⑥ 负例：名字不合字符集 ⇒ 不插 chip，退回纯文本（用户的字一个不丢）', async () => {
    const b = await boot();
    const ok = b.c.insertComposerChip({ kind: 'command', name: 'Not A Name', start: 0, end: 0, trailing: ' ' });
    expect(ok, '拼不出规范形态就不许插 chip').toBe(false);
    expect(chips().length, '不得留下半截形状').toBe(0);
  });
});

// ───────────────── ② 原子删除（E2）─────────────────
describe('A4b · Backspace 原子删除（E2：不留 skill:rev 残肢）', () => {
  it('① Backspace 触及 chip ⇒ 整个 chip 消失，规范文本里连一个残字都没有', async () => {
    const b = await boot();
    b.composer.type('/skill:review');
    await flush();
    // trailing 空串 ⇒ caret 就落在 chip 之后（真实用户敲完 token 时的位置）。
    b.c.insertComposerChip({ kind: 'skill', name: 'review', start: 0, end: 13, trailing: '' });
    await flush();
    expect(chips().length, '前置：chip 在').toBe(1);
    b.composer.press({ key: 'Backspace' });
    await flush();
    expect(chips().length, '★ chip 必须整块删除').toBe(0);
    expect(b.c.canonicalText(), '★ 不得留下 skill:rev 这种残肢').toBe('');
  });

  it('② chip 后面的普通文字不受影响（Backspace 只吃紧邻的那个原子）', async () => {
    const b = await boot();
    b.composer.type('帮我看看');
    await flush();
    b.c.insertComposerChip({ kind: 'skill', name: 'review', start: 0, end: 0, trailing: '' });
    await flush();
    b.composer.press({ key: 'Backspace' });
    await flush();
    expect(chips().length, '★ chip 整块消失').toBe(0);
    expect(b.c.canonicalText(), '旁边的字一个不许少').toBe('帮我看看');
  });
});

// ───────────────── ③ 草稿往返 + 旧指纹降级（E3 纪律②③）─────────────────
describe('A4b · 草稿：chip 进冻结注册表 ⇒ 旧草稿按纪律③降级纯文本', () => {
  it('① 带 chip 的草稿往返 ⇒ 按状态恢复（chip 还在）', async () => {
    const b = await boot({ skills: [REVIEW] });
    await withLists(b);
    await type(b, '/skill:review');
    await pickBy(b, '/skill:review');
    const payload = b.c.draftPayload();
    b.composer.type('');
    expect(b.c.restoreDraftPayload(payload), '版本与 node 指纹都对得上').toBe('state');
    expect(chipAttrs(), '恢复后 chip 仍在').toEqual([{ kind: 'skill', name: 'review', stale: false }]);
    expect(b.c.canonicalText()).toBe('/skill:review ');
  });

  it('② 载荷里的规范文本明文副本 = 规范形态（降级路径的兜底也拿得到 chip 的形状）', async () => {
    const b = await boot({ skills: [REVIEW] });
    await withLists(b);
    await type(b, '/skill:review');
    await pickBy(b, '/skill:review');
    const parsed = JSON.parse(b.c.draftPayload()) as { text: string; nodes: string };
    expect(parsed.text).toBe('/skill:review ');
    expect(parsed.nodes.split(','), '★ chip 必须登记在冻结的 node 注册表里').toContain('composer-chip');
  });

  it('③ ★ 旧指纹草稿 ⇒ 降级纯文本（新增 node 类型是契约变更，纪律②在起作用）', async () => {
    const b = await boot();
    const legacy = JSON.stringify({
      v: 1,
      nodes: 'root,paragraph,text,linebreak',
      text: '/skill:review 老草稿',
      state: '{"root":{"children":[],"type":"root","version":1}}',
    });
    expect(b.c.restoreDraftPayload(legacy), '旧注册表指纹不得按状态恢复').toBe('text');
    expect(b.c.canonicalText(), '★ 降级仍要把字读回来（宁可丢 chip，不丢字）').toBe('/skill:review 老草稿');
    expect(chips().length).toBe(0);
  });
});

// ───────────────── ④ 失配降级（E5）─────────────────
describe('A4b · E5 失配降级：引用的名字失效 ⇒ 显示降级为普通文本，投影不变', () => {
  it('① 技能从清单消失 ⇒ chip 显示降级（视觉不再是 chip），规范文本一字不变', async () => {
    const b = await boot({ skills: [REVIEW] });
    await withLists(b);
    await type(b, '/skill:review');
    await pickBy(b, '/skill:review');
    expect(chipAttrs()[0]!.stale, '前置：命中时不是降级态').toBe(false);
    // 换一个不含 review 的清单 = 技能被删。
    b.c.refreshComposerChips((_k, n) => n !== 'review');
    await flush();
    expect(chipAttrs()[0]!.stale, '★ 显示必须降级为普通文本样式').toBe(true);
    // 基类恒在（判定「是不是 chip」只有一个判据）；**视觉**上的降级由 -stale 规则负责，
    // 所以这里断的是那条规则真的去掉了底块 —— 那正是 E5 承诺的「看起来不再是 chip」。
    expect(chipCss(), '降级样式必须去掉底块').toMatch(/[.]composer-chip-stale\s*\{[^}]*background:\s*none/);
    expect(b.c.canonicalText(), '★ 文本投影一字不变：发送仍按纯文本走原解析管线').toBe('/skill:review ');
  });

  it('② server 下线 ⇒ 同一条降级路径（不是只对技能生效）', async () => {
    const b = await boot({ servers: [{ server: 'memory' }] });
    await withLists(b);
    await type(b, '/mcp:memory');
    await pickBy(b, '/mcp:memory');
    b.c.refreshComposerChips((kind) => kind !== 'mcp');
    await flush();
    expect(chipAttrs()[0]!.stale).toBe(true);
    expect(b.c.canonicalText()).toBe('/mcp:memory ');
  });

  it('③ 清单重拉后自动重判（走真实的 onPaneChange 失效路径，不手动调重判）', async () => {
    // 这条钉的是**接线**：重判必须挂在「清单重拉」这条路上（reloadSkills.then(...)），
    // 否则清单一变、药丸还停在旧状态 —— 用户看见的是「技能还在，chip 却降级了」。
    const b = await boot({ skillsBySession: { 'ws/s1': [REVIEW], 'ws/s2': [], 'ws/s3': [REVIEW] } });
    await withLists(b);
    b.composer.type('/skill:review');
    await flush();
    b.c.insertComposerChip({ kind: 'skill', name: 'review', start: 0, end: 13, trailing: '' });
    await flush();
    expect(chipAttrs()[0]!.stale, '前置：清单里有 review，不是降级态').toBe(false);
    // 切到没有该技能的工作区 = 技能被删。
    const ctx = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctx.ensurePane('ws/s2', 'session', '乙会话');
    ctx.activatePane('ws/s2', 'session', '乙会话');
    await flush(12);
    expect(chipAttrs()[0]!.stale, '清单失效重拉之后 chip 必须自动降级').toBe(true);
    expect(b.c.canonicalText(), '投影仍是一字不变的那一份').toBe('/skill:review');
    // ★ 反向一半才是这条断言的**判别力**：再切回有该技能的工作区，chip 必须**恢复**。
    //   只断「降级」的话，「重判压根没接线」也能过（缓存恰好是空的那一瞬间也是降级）；
    //   断「恢复」就要求重判发生在**清单位到之后**，接线漏了就红。
    ctx.ensurePane('ws/s3', 'session', '丙会话');
    ctx.activatePane('ws/s3', 'session', '丙会话');
    await flush(12);
    expect(chipAttrs()[0]!.stale, '★ 清单位到 ⇒ chip 必须恢复成 chip').toBe(false);
  });

  it('④ 降级是**幂等**的：裁决没变就不产生更新（否则每次刷新都把编辑器叫醒）', async () => {
    const b = await boot({ skills: [REVIEW] });
    await withLists(b);
    await type(b, '/skill:review');
    await pickBy(b, '/skill:review');
    expect(b.c.refreshComposerChips(() => true), '没有状态变化 ⇒ 不该有更新').toBe(false);
    expect(b.c.refreshComposerChips(() => false), '状态真的变了 ⇒ 必须报出来').toBe(true);
  });
});

// ───────────────── ⑤ /mcp: 补全源的缓存纪律 ─────────────────
describe('A4b · /mcp: 补全源：同步缓存纪律（miss 按未命中、失败不写缓存）', () => {
  it('① 缓存未到时按未命中：补全框只有命令组，没有 MCP 组', async () => {
    const b = await boot({ servers: [{ server: 'memory' }] });
    await type(b, '/mcp:');
    const labels = all('#cmdPopup .cmd-name').map((n) => n.textContent ?? '');
    expect(labels.every((l) => !l.startsWith('/mcp:')), '缓存未到不得列出 server').toBe(true);
  });

  it('② 端点失败 ⇒ 不写缓存（不得把「拉不到」记成「没有 server」）', async () => {
    const b = await boot();
    vi.stubGlobal('fetch', async () => reply(500, { error: 'boom' }));
    await b.mcp.refreshMcpServers();
    expect(b.mcp.mcpServerNames(), '失败后缓存仍为空').toEqual([]);
    expect(b.mcp.mcpCached(), '★ 失败不得写缓存').toBe(false);
  });

  it('③ server 名不合字符集 ⇒ 不进清单（拼不出 /mcp:<server> 的东西不算 server）', async () => {
    const b = await boot();
    vi.stubGlobal('fetch', async (url: unknown) =>
      String(url).includes('/api/plugins')
        ? reply(200, pluginsResp([{ server: 'Bad Name' }, { server: 'ok_1' }]))
        : reply(200, { ok: true }),
    );
    await b.mcp.refreshMcpServers();
    expect(b.mcp.mcpServerNames()).toEqual(['ok_1']);
  });

  it('④ 失联的 server 仍列出来，desc 如实标状态（用户要能看见它坏了）', async () => {
    const b = await boot({ servers: [{ server: 'memory', state: 'failed', toolCount: 0 }] });
    await withLists(b);
    await type(b, '/mcp:');
    const row = all('#cmdPopup .cmd-row').find((r) => r.querySelector('.cmd-name')?.textContent === '/mcp:memory');
    expect(row, '失联的 server 也要列出来').toBeDefined();
    expect(row?.querySelector('.cmd-desc')?.textContent ?? '', 'desc 如实标状态').toContain('failed');
  });
});
