// ============================================================================
// ui/commands/skills.ts — 技能清单的**前端缓存**（skill-command.md §4 切片 2 第 2/4 步）。
// ----------------------------------------------------------------------------
// 数据源只有一个：GET /api/sessions/{id}/skills（切片 1 的端点）。前端**自己扫盘**是
// ZCode 踩过的坑（界面看得见、会话调不到），所以这里只有拉取，没有第二条发现路径。
//
// ★ 同步缓存纪律（文档切片 2 原文）：放行判定**只读同步缓存**，缓存 miss 按「未命中」
//   处理——`clearInput` 在 dispatchCommand resolve 之前执行，若放行判定等网络拉清单，
//   会出现「输入框已清空、消息还没发出去」的可见间隙。清单的新近性由 host 侧再校验
//   兜底（未命中时注入一条可见的失败行），技能的识别可靠性不依赖前端这一次判断。
//   ⇒ 本模块对判定侧只暴露**同步**读取（skillNames / isSkillGesture），网络一律异步。
//
// ★ 缓存时效（文档切片 2 原文）：commandProvider 是同步函数、会读到过期清单。做法是
//   在 onPaneChange（会话切换）时失效重拉，并在补全首次打开且缓存为空时异步补拉一次；
//   popup 引擎自带 seq 竞态守卫，不需要为异步额外改造。
// ============================================================================
import { SKILL_NAME_PATTERN, canonicalSlash, parseSlashGesture } from '@celestea/gesture';

import { api } from '../../api';
import type { SkillEntry } from '../../types/skill';
import type { PopupItem } from './popup';
import { t } from '../../i18n';

/**
 * 缓存里的一份清单（技能是**该会话工作区**的能力，不是全局的）。
 *
 * 这里**不存会话 id**：判据是「缓存非空」，正确性来自 onPaneChange 的真失效
 * （切会话先清空再重拉），而不是「比对 id」——后者需要把 pane 一路传进判定，
 * 为一个已经由失效保证的不变量再加一条依赖，不划算。
 */
interface SkillCache {
  skills: SkillEntry[];
  /** 与 skills 同序的技能名：放行判定每次按名查，预存一份免得每次现映射。 */
  names: string[];
}

let cache: SkillCache | null = null;
/** 竞态守卫（FRONTEND-RULES 铁律 3）：晚到的旧会话结果一律丢弃，绝不覆盖新会话的清单。 */
let seq = 0;
/** 同一会话在飞时不重复打端点（补全每敲一个键都会要一次清单）。 */
let inflight = '';

/** 清单**已到**吗（补全首次打开时的补拉判据）。 */
export function skillsCached(): boolean {
  return cache !== null;
}

/** 缓存里的技能清单（同步读；空 = 缓存未到或该会话没有技能）。 */
export function cachedSkills(): readonly SkillEntry[] {
  return cache?.skills ?? [];
}

/** 缓存里的技能名（放行判定只认它；空 = 一律按未命中处理）。 */
export function skillNames(): readonly string[] {
  return cache?.names ?? [];
}

/**
 * 会话切换：失效并重拉。**真的清空**（不是留着旧清单等新结果）——
 * 旧会话的技能对新会话一律不算数，留着等于给别的会话开了后门。
 */
export function reloadSkills(session: string): void {
  cache = null;
  seq += 1;
  inflight = '';
  void refreshSkills(session);
}

/** 拉一次清单并填缓存（失败**不写**缓存：下一次补全打开会再拉，而不是把「拉不到」记成「没有技能」）。 */
export async function refreshSkills(session: string): Promise<void> {
  if (session === '' || inflight === session) return;
  inflight = session;
  const my = ++seq;
  try {
    const resp = await api.sessionSkills(session);
    if (my !== seq) return;
    const skills = (resp.skills ?? []).filter(isListable);
    cache = { skills, names: skills.map((s) => s.name) };
  } catch {
    if (my === seq) cache = null;
  } finally {
    if (my === seq) inflight = '';
  }
}

/**
 * 端点回体里的技能行能不能用：名字必须过**唯一定义处**的技能名字符集，
 * 否则 `/{name}` 与 `/skill:<name>` 都拼不出来（canonicalSlash 同样会拒绝它）。
 */
function isListable(s: SkillEntry): boolean {
  return SKILL_NAME_PATTERN.test(s.name);
}

/**
 * 这一行是不是「显式调用某个技能」的手势。**只读同步缓存**（见文件头那条纪律）。
 *
 * 判定用 gesture 包的那份解析函数而不是 `parseLine`：`parseLine` 不校验字符集，
 * 两份判定会分叉——正是 skill-command.md §1.4 要消灭的「前端认了、host 不认」。
 * 裸 token 的语法 kind 一律是 command（`/review` 与 `/help` 语法不可区分），
 * **清单裁决在调用方**，这正是 gesture 包的既定语义。
 */
export function isSkillGesture(line: string): boolean {
  const gesture = parseSlashGesture(line.trim());
  // kind 'mcp' 是第三种命名空间（尚未落地），它不查技能清单。
  if (gesture === null || gesture.kind === 'mcp') return false;
  return skillNames().includes(gesture.name);
}

/**
 * 技能候选（技能组）。按名字前缀过滤，**显示与写回都用规范形态** `/skill:<name>`：
 * 用户一眼就知道自己选的是技能命名空间（skill-command.md §1.5），且没有空格，
 * 补全引擎的补全条件 `无空白` 仍然成立。
 */
export function skillItems(prefix: string): PopupItem[] {
  const p = prefix.toLowerCase();
  const out: PopupItem[] = [];
  for (const s of cachedSkills()) {
    if (!s.name.toLowerCase().startsWith(p)) continue;
    const canonical = canonicalSlash('skill', s.name);
    if (canonical === null) continue;
    out.push({
      label: canonical,
      desc: s.description,
      value: canonical,
      group: t('chat.skill.group'),
    });
  }
  return out;
}
