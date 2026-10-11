// ============================================================================
// ui/commands/index.ts — A3/H：补全框的**装配与派发**（斜杠命令 + @文件，单一引擎）。
//   '/' 开头  → 命令提供者（注册表同步过滤）
//   '@' 开头  → 文件提供者（GET /api/fs/list；只列路径、绝不读内容）
//   '!xxx'    → 归一化为 '/run xxx'（等价快捷方式），命中即消费、不发 /api/turn。
//   命令被消费时不发消息；未知命令/列举失败都给可读提示（不静默）。
// ============================================================================
import { listCommands, type Command } from './registry';
import { registerBuiltinCommands } from './builtin';
import {
  hideCompletion, initCompletion, showCompletion, completionKey, setProvider,
  type PopupItem,
} from './popup';
import { activePane, onPaneChange, type SessionPane } from '../viewctx';
// §9.2：补全框的读写全部走输入栏适配缝，不再碰编辑器元素（value / selectionStart）。
import {
  canonicalText,
  composerRoot,
  focusComposer,
  insertComposerChip,
  onComposerChange,
  refreshComposerChips,
  replaceComposerRange,
  setComposerKeyInterceptor,
  textBeforeCaret,
} from '../composer';
import type { ChipKind } from '../composer/chip';
import { renderInfoBlock } from '../messages';
import { listMentions } from './files';
import { isSkillGesture, refreshSkills, reloadSkills, skillItems, skillNames, skillsCached } from './skills';
import { listCommands as _listCommands } from './registry';
import { isMcpGesture, mcpCached, mcpItems, mcpServerNames, refreshMcpServers, reloadMcpServers } from './mcp';
import { t } from '../../i18n';

export { onGoalChange, goalOf, renderGoalBar, syncGoalOnActivate } from './goal';
import { renderGoalBar as refreshGoalBar, onGoalChange, syncGoalOnActivate } from './goal';
export { listCommands, filterCommands, completionPrefix } from './registry';
export { workspacePath } from './files';

/** 把 `!xxx` 归一化为 `/run xxx`；非 `!` 行原样返回。 */
export function normalizeBang(line: string): string {
  const t = line.trim();
  if (!t.startsWith('!')) return line;
  const rest = t.slice(1).trim();
  return rest === '' ? '/' : '/run ' + rest;
}

/** 输入行是否是命令（归一化后以 '/' 开头且非空）。 */
export function isCommand(line: string): boolean {
  const t = normalizeBang(line).trim();
  return t.startsWith('/') && t.length > 1;
}

/** 从完整输入行解析出命令名与参数（原样）。 */
function parseLine(line: string): { name: string; args: string } {
  const t = normalizeBang(line).trim();
  const body = t.slice(1);
  const sp = body.search(/\s/);
  if (sp < 0) return { name: body, args: '' };
  return { name: body.slice(0, sp), args: body.slice(sp + 1) };
}

/**
 * 定位光标处的 `@` 片段：从光标往回找到 token 起点的 '@'。
 * 返回 {start, after}；after = '@' 与光标之间的已输入片段（用于前缀过滤/逐级进入）。
 */
export function mentionToken(line: string, caret: number): { start: number; after: string } | null {
  let i = Math.min(caret, line.length) - 1;
  while (i >= 0 && !/\s/.test(line[i]!)) {
    if (line[i] === '@') return { start: i, after: line.slice(i + 1, caret) };
    i -= 1;
  }
  return null;
}

/**
 * 执行一条命令（由 send 入口在发送前调用）。
 * 返回 true = 已消费（调用方**不要**再发消息）；'@' 提及不是命令，返回 false。
 *
 * ★ 三路判定表（skill-command.md §4 切片 2；顺序即优先级）：
 *     命令表命中 → cmd.run(...)      → 消费（撞名时**命令优先**，与 DSH 一致）
 *     技能清单命中 → return false    → 放行给 host（发出去的是**原文**，不改写）
 *     两者都没有 → 未知命令提示      → 消费（保持现有行为，不静默）
 *   技能的裁决只读**同步缓存**（见 ui/commands/skills.ts 的文件头纪律）：
 *   缓存未到 ⇒ 按未命中处理 ⇒ 走那条**可见的**未知命令提示，host 侧还有一层兜底。
 */
export async function dispatchCommand(line: string, ctx?: SessionPane): Promise<boolean> {
  const pane = ctx ?? activePane();
  if (!pane) return false;
  // '@' 提及只是文本，不是命令；交给普通发送路径（只传路径）。
  if (mentionToken(line, line.length) !== null) return false;
  const { name, args } = parseLine(line);
  if (name === '') return false;
  const cmd = listCommands().find((c) => c.name === name);
  if (!cmd) {
    if (isSkillGesture(line)) return false;
    // D1 (mcp-client.md §5.6): `/mcp:<server>` 是第三个命名空间，与技能手势**同构**
    // —— 前端不消费，放行给 host，由它按本代的 server 清单确定性注入。未命中由 host
    // 响亮失败（不是这里的「没有这个命令」：那句话说的是命令，说的是错的东西）。
    if (isMcpGesture(line)) return false;
    renderInfoBlock(pane, t('chat.command.unknown', { name }), 'warn');
    return true;
  }
  hideCompletion();
  return await cmd.run({ raw: line, args, ctx: pane });
}

/**
 * 把选中的**命令/技能/MCP server**插成一个 chip（composer-surface §8）。
 *
 * ★ 为什么是 chip 而不是纯文本（§8 的原话）：chip 的文本投影**就是规范形态**，
 *   所以「用户看见的药丸」与「发送出去的字符串」是同一份投影 —— host 侧一行不改。
 *   选中即改写规范形态（skill-command §1.5 D4）在这里第一次有了视觉体现。
 *
 * ★ 尾随空格保持既有行为：选中命令后留一个空格便于继续打参数（W3 之前由
 *   applyCommand 拼在字符串末尾，现在它跟在 chip **后面**，仍然是一个普通文本节点）。
 *
 * ★ fallback：chip 插不进去（名字拼不出规范形态）时**退回纯文本**，
 *   宁可是普通文本，也不能让用户已经打的字凭空消失。
 */
function applyGesture(item: PopupItem): void {
  const next = item.value + (item.value.endsWith(' ') ? '' : ' ');
  const kind = gestureKindOf(item);
  const inserted =
    kind !== null &&
    insertComposerChip({ kind, name: nameOf(item, kind), start: 0, end: canonicalText().length, trailing: ' ' });
  if (!inserted) replaceComposerRange(0, Number.MAX_SAFE_INTEGER, next);
  hideCompletion();
  focusComposer();
}

/** 这一项属于 `/` 面的哪种 kind（按**规范形态前缀**判，不猜 label）。 */
function gestureKindOf(item: PopupItem): ChipKind | null {
  const v = item.value;
  if (v.startsWith('/skill:')) return 'skill';
  if (v.startsWith('/mcp:')) return 'mcp';
  if (v.startsWith('/')) return 'command';
  return null;
}

/** chip 的名字：规范形态**去掉前缀**（`/skill:review` ⇒ `review`），
 *  与 @celestea/gesture 的 canonicalSlash 严格互逆 —— 拼不回去就说明哪边错了，
 *  此时返回原串，由 insertChip 的返回值把整条路退回纯文本。 */
function nameOf(item: PopupItem, kind: ChipKind): string {
  const v = item.value;
  if (kind === 'skill') return v.slice('/skill:'.length);
  if (kind === 'mcp') return v.slice('/mcp:'.length);
  return v.slice(1);
}

/** 把选中的文件路径插成 **@文件 chip**（只传路径，不读内容 —— 见 files.ts 的用户裁决）。 */
function applyMention(item: PopupItem): void {
  const before = textBeforeCaret();
  const tok = mentionToken(before, before.length);
  if (tok === null) return;
  // 光标前的 [tok.start, 光标) 整段换掉；光标之后的原文由编辑器保留。
  // 目录不插 chip：`@src/` 还要继续列下一级（逐级进入），chip 化会把候选吃掉。
  const inserted =
    item.value.endsWith('/')
      ? false
      : insertComposerChip({ kind: 'mention', name: item.value, start: tok.start, end: before.length, trailing: '' });
  if (!inserted) replaceComposerRange(tok.start, before.length, '@' + item.value);
  // 目录：插入后继续列出该目录（逐级进入）；文件：关闭补全。
  if (item.value.endsWith('/')) void refresh(canonicalText(), tok.start + item.value.length + 1);
  else hideCompletion();
  focusComposer();
}

/**
 * E5（失配降级）：按**同步缓存**里的三份清单重判每个 chip。
 *
 * 判定必须读清单而不是「chip 自己记得的样子」—— 技能被删 / server 下线之后，
 * chip 该显示成普通文本样式（§8），而它的**文本投影一字不变**，发送仍按纯文本
 * 走原解析管线。缓存未到一律按「失配」处理：宁可不显示成 chip，也不显示一个
 * 用户根本没选过的样子。
 */
function syncChipStates(): void {
  const commands = new Set(_listCommands().map((c) => c.name));
  const skills = new Set(skillNames());
  const servers = new Set(mcpServerNames());
  refreshComposerChips((kind, name) => {
    if (kind === 'command') return commands.has(name);
    if (kind === 'skill') return skills.has(name);
    if (kind === 'mcp') return servers.has(name);
    return true; // @文件：没有清单可比对（工作区随时在变），不因此降级
  });
}

/** 文件提供者：列举 `@` 之后的片段（异步；popup 引擎自带 seq 竞态守卫）。 */
async function fileProvider(after: string): Promise<PopupItem[]> {
  const out = await listMentions(after);
  if (out.notice !== '') {
    const pane = activePane();
    if (pane) renderInfoBlock(pane, out.notice, 'warn');
  }
  return out.items;
}

/** 命令候选（命令组）：注册表同步过滤。 */
function commandItems(prefix: string): PopupItem[] {
  const p = prefix.toLowerCase();
  return listCommands()
    .filter((c: Command) => c.name.toLowerCase().startsWith(p))
    .map((c) => ({
      label: '/' + c.name,
      desc: c.desc,
      meta: c.args,
      value: '/' + c.name,
      group: t('chat.command.group'),
    }));
}

/**
 * 命令提供者：**命令组在前、技能组在后**（composer-surface §1.3 的分组能力）。
 *
 * 技能项只来自**同步缓存**（缓存纪律见 ui/commands/skills.ts）；缓存为空时顺手
 * 异步补拉一次——这一次的列表仍是命令，下次打开补全就有技能了。拉取**不 await**：
 * popup 引擎自带 seq 竞态守卫，晚到的旧结果不会覆盖新前缀。
 */
async function commandProvider(prefix: string): Promise<PopupItem[]> {
  const pane = activePane();
  // 只在**缓存为空**时补拉；refreshSkills 自带「同会话在飞不重复打」的去重，
  // 所以连着敲 /sk… 也不会每键一发。失效重拉是 onPaneChange 那条路（reloadSkills）。
  // ★ 两份清单都是**异步**到的，所以补拉之后必须**跟着重判一次 chip**（E5）：
  //   清单一到就该把「失配」的 chip 恢复成 chip。忘了这一跟，用户看到的是一个
  //   永远降级态的药丸（本仓熟悉的失效形状：生效了但看不见 / 反过来）。
  if (pane !== null && !skillsCached()) void refreshSkills(pane.id).then(syncChipStates, () => {});
  // MCP 清单同一条纪律（mcp.ts 的缓存是进程级的，不按会话分键）。
  if (!mcpCached()) void refreshMcpServers().then(syncChipStates, () => {});
  // 三组顺序 = 命令 / 技能 / MCP（§1.3 的分组头靠它渲染；组头不进 items）。
  return [...commandItems(prefix), ...skillItems(prefix), ...mcpItems(prefix)];
}

/** 按当前输入行与光标刷新补全框（'/' 命令 / '@' 文件）。 */
export async function refresh(line: string, caret?: number): Promise<void> {
  const pos = caret ?? line.length;
  const tok = mentionToken(line, pos);
  if (tok !== null) {
    setProvider(fileProvider);
    await showCompletion(tok.after);
    return;
  }
  if (line.startsWith('/') && !/\s/.test(line.slice(1))) {
    setProvider(commandProvider);
    await showCompletion(line.slice(1));
    return;
  }
  setProvider(null);
  hideCompletion();
}

let installed = false;

/** 装配（幂等；main.ts 在 viewctx/inputbar 之后调用一次）。 */
export function installCommands(): void {
  if (installed) return;
  installed = true;
  registerBuiltinCommands();
  const input = composerRoot();
  if (!input) return;
  // §9.2：键盘**总**拦截口装在编辑器上（不是挂一个 DOM keydown 监听器）——
  //   只有这样才能保证「补全框先于 Enter 发送」是编排层的一个显式决定，
  //   而不是「谁的监听器先注册」这种会随实现漂移的偶然（W9349 的教训）。
  setComposerKeyInterceptor((e) => completionKey(e));
  onPaneChange((pane) => {
    refreshGoalBar();
    // W9349：会话被激活时读回**已存在**的目标（刷新/切换后胶囊不消失的那一半）。
    // 与胶囊同一个 onPaneChange 入口；回声落地后由 onGoalChange 走同一条渲染路径重画。
    syncGoalOnActivate(pane);
    // 技能清单时效：会话切换 = 换了一份工作区 ⇒ 旧清单作废、失效重拉。
    // 这是补全首次打开那条补拉之外的**主路径**：切完会话清单通常已经就绪。
    void reloadSkills(pane.id).then(syncChipStates, () => {});
    // MCP 清单是进程级的（插件行不属于某个会话），但会话切换仍是最可靠的刷新时机：
    // 新一代会话的连接状态此刻才开始发布。E5 的失配重判跟着清单一起走。
    void reloadMcpServers().then(syncChipStates, () => {});
    syncChipStates();
  });
  onGoalChange(() => refreshGoalBar());
  setProvider(null);
  initCompletion(input, (item) => {
    if (item.label.startsWith('/')) applyGesture(item);
    else applyMention(item);
  });
  syncChipStates();
  // 内容变化由适配缝推上来（不再监听 input 事件 —— §9.2 之后编辑器不发原生 input）。
  onComposerChange((c) => void refresh(c.text, c.before.length));
  input.addEventListener('focusout', () => hideCompletion());
}

/** 供 send 入口快速判断（`!` 也认）。 */
export function isCommandLike(line: string): boolean {
  return isCommand(line);
}

/** 输入框 keydown 的总拦截口（inputbar 的 Enter 处理前调用）。 */
export function interceptKey(e: { key: string; shiftKey?: boolean; preventDefault(): void }): boolean {
  return completionKey(e);
}

export { completionVisible, activeItemLabel } from './popup';
