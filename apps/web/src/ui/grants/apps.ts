// ============================================================================
// ui/grants/apps.ts — desktop 能力位的**应用清单**（M2-B2a）：草稿解析 / 校验 /
//   scope 构造 / 摘要文案。纯函数，零 DOM、零网络、零 import（可被 node 直接加载，
//   也可被 esbuild 打包进 check-grants-permanent 那样的机械断言）。
//
// 为什么单独一层：应用清单是**嵌套对象**（allow/deny 各一份 exes/titles 清单），
// 与 roots/hosts/tools 那种「一个文本框 → 一个数组」的既有形态不同。把它挤进
// rows.ts 会让面板行同时承担「DOM 结构 + 输入解析 + 校验 + 文案」，而其中解析与
// 校验正是**必须能被机械断言**的那部分（形状一旦漂移，前端 scope_hash 与服务端
// 就对不上 ⇒ 每次授予 403，见 security/scope-hash.ts 头注的 692f19c 事故）。
//
// 文案纪律（与 flow.ts / copy.ts 同一条安全不变量）：本模块面向用户的字符串
// **全部是固定常量句式**，绝不采用工具输出或模型文本；清单里的值（exe 名/窗口
// 标题）只作为**数据**填入固定句式。
//
// 语义（与后端 store/grants.ts 的 validateAppScope 同口径）：
//   · `allow` 为空/缺席 = **不限制**（desktop 是一个能力位，清单是可选的收窄）；
//   · `deny` 永远赢；
//   · 两侧都空 ⇒ 提交时不带 `apps` 键（= 纯能力位，服务端 OPTIONAL_SCOPE_CAPS 接受）；
//     若带上空的 apps，服务端 validateAppScope 会判 400「must name at least one entry」。
// ============================================================================
import type { GrantAppList, GrantAppScope, GrantScope } from '../../types';
import { t } from '../../i18n';

/** 一份应用清单的两个字段（allow / deny 各一份）。 */
export const APP_LIST_FIELDS: readonly ['exes', 'titles'] = ['exes', 'titles'];

/** 应用清单的两侧：allow 是可选的收窄，deny 永远赢。 */
export const APP_SIDES: readonly ['allow', 'deny'] = ['allow', 'deny'];

export type AppListField = (typeof APP_LIST_FIELDS)[number];
export type AppSide = (typeof APP_SIDES)[number];

/** 四个录入框的草稿（rows.ts 建输入框、flow.ts 取 scope 都读这一份）。 */
export interface AppsDraft {
  allowExes: string;
  allowTitles: string;
  denyExes: string;
  denyTitles: string;
}

export function emptyAppsDraft(): AppsDraft {
  return { allowExes: '', allowTitles: '', denyExes: '', denyTitles: '' };
}

/** 每个录入框 → scope 里的位置（唯一真源：界面字段名与线格式不会各写一份）。 */
export function draftFieldOf(side: AppSide, field: AppListField): keyof AppsDraft {
  const cap = side === 'allow' ? 'allow' : 'deny';
  const name = field === 'exes' ? 'Exes' : 'Titles';
  return `${cap}${name}` as keyof AppsDraft;
}

/**
 * 一份清单的分隔规则：逗号 / 分号 / 换行。
 *
 * ⚠ 与 scope.ts 的 splitList 不同，**刻意不按空白切**：应用清单里装的是 exe 名或
 * 完整路径，而 Windows 路径（`C:\\Program Files\\App\\a.exe`）与窗口标题
 * （`另存为 - 记事本`）里都有空格。按空白切会把一个合法值劈成两半。
 * 每项各自 trim（首尾空白）后去重，保留首现序。
 */
export function splitAppEntries(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[,\uFF0C;\uFF1B\r\n]+/)
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    ),
  );
}

/**
 * 草稿文本 → 四个清单（空串 ⇒ 空数组）。
 *
 * 服务端对清单值的要求（store/grants.ts::readScopeList）这里是**客户端镜像**，
 * 目的是把 400 挡在提交之前（错误就近显示在那一行），不是替代服务端校验：
 *   · 非空字符串； · 逐项 trim； · 去重； · 单项 ≤ 200 字符； · 每侧 ≤ 32 项；
 *   · 疑似凭据（`sk-` / `Bearer ` / 含换行 / > 200 字符）拒绝，且不回显该值。
 */
export interface AppsParsed {
  allow: GrantAppList;
  deny: GrantAppList;
  /** 命中凭据形状的项（不回显值）：用于错误文案，恒为布尔，不携带原文。 */
  credential: boolean;
  /** 单项超过长度上限（服务端也会拒）。 */
  tooLong: boolean;
  /** 某一侧的条数超过上限（服务端也会拒）。 */
  tooMany: boolean;
}

/** 单项长度上限（与 scope.ts 的 looksLikeCredential 阈值同口径：>200 判凭据）。 */
const MAX_ENTRY_CHARS = 200;
/** 每侧条数上限（服务端 MAX_SCOPE_ENTRIES = 32）。 */
const MAX_ENTRIES = 32;

function looksLikeCredentialEntry(v: string): boolean {
  return /sk-/.test(v) || /Bearer\s/.test(v) || v.includes('\n');
}

export function parseAppsDraft(draft: AppsDraft): AppsParsed {
  const allow: GrantAppList = {};
  const deny: GrantAppList = {};
  let credential = false;
  let tooLong = false;
  let tooMany = false;
  for (const side of APP_SIDES) {
    const target = side === 'allow' ? allow : deny;
    for (const field of APP_LIST_FIELDS) {
      const values = splitAppEntries(draft[draftFieldOf(side, field)]);
      if (values.length > MAX_ENTRIES) tooMany = true;
      const kept: string[] = [];
      for (const v of values) {
        // 两种拒绝分开记：`>200 字符` 与「像凭据」在服务端也是两条不同的 400
        // （entry is longer than … chars / value looks like a credential），
        // 合成一条会让用户按「凭据」去排查一个纯粹太长的值。
        if (v.length > MAX_ENTRY_CHARS) {
          tooLong = true;
          continue;
        }
        if (looksLikeCredentialEntry(v)) {
          credential = true;
          continue;
        }
        kept.push(v);
      }
      if (kept.length > 0) target[field] = kept;
    }
  }
  return { allow, deny, credential, tooLong, tooMany };
}

/** 清单是否为空（一侧的 exes 与 titles 都没有内容）。 */
function listEmpty(l: GrantAppList): boolean {
  return (l.exes?.length ?? 0) === 0 && (l.titles?.length ?? 0) === 0;
}

/**
 * 草稿 → 提交给服务端的 `scope.apps`；**两侧都空 ⇒ null**（= 不带 apps 键的纯能力位）。
 * 服务端会拒绝「有 apps 键但一个条目都没有」的形状，所以这一层必须先把空收掉。
 */
export function appsScopeOf(draft: AppsDraft): GrantAppScope | null {
  const p = parseAppsDraft(draft);
  const apps: GrantAppScope = {};
  if (!listEmpty(p.allow)) apps.allow = p.allow;
  if (!listEmpty(p.deny)) apps.deny = p.deny;
  return apps.allow === undefined && apps.deny === undefined ? null : apps;
}

/** desktop 的完整 scope：有清单才带 `apps`，否则是 `{}`（与未授予清单时逐字相同）。 */
export function desktopScopeOf(draft: AppsDraft): GrantScope {
  const apps = appsScopeOf(draft);
  return apps === null ? {} : { apps };
}

// ---- 已授予条目的回读（面板展示） ----------------------------------------------

/** 从一条授权记录的 scope 里宽松读出应用清单（形状不对就当空，绝不抛）。 */
export function appsOfScope(scope: GrantScope | undefined): GrantAppScope {
  const raw = scope?.apps;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: GrantAppScope = {};
  for (const side of APP_SIDES) {
    const value = (raw as Record<string, unknown>)[side];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const list: GrantAppList = {};
    for (const field of APP_LIST_FIELDS) {
      const v = (value as Record<string, unknown>)[field];
      const kept = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
      if (kept.length > 0) list[field] = kept;
    }
    if (!listEmpty(list)) out[side] = list;
  }
  return out;
}

export interface AppsCounts {
  allowExes: number;
  allowTitles: number;
  denyExes: number;
  denyTitles: number;
  /** 两侧合计（0 = 不限制）。 */
  total: number;
}

export function appsCounts(apps: GrantAppScope): AppsCounts {
  const allowExes = apps.allow?.exes?.length ?? 0;
  const allowTitles = apps.allow?.titles?.length ?? 0;
  const denyExes = apps.deny?.exes?.length ?? 0;
  const denyTitles = apps.deny?.titles?.length ?? 0;
  return { allowExes, allowTitles, denyExes, denyTitles, total: allowExes + allowTitles + denyExes + denyTitles };
}

// ---- 面向用户的固定句式（语言切换后必须跟着变 ⇒ 惰性函数） ----------------------

/** 一份清单的短语（固定句式 + 数值/值作数据填入）。空清单 ⇒ 空串（由调用方决定说不说）。 */
export function appListPhrase(l: GrantAppList | undefined): string {
  const exes = l?.exes?.length ?? 0;
  const titles = l?.titles?.length ?? 0;
  if (exes === 0 && titles === 0) return '';
  if (exes > 0 && titles > 0) return t('grants.apps.listBoth', { exes, titles });
  return exes > 0 ? t('grants.apps.listExes', { exes }) : t('grants.apps.listTitles', { titles });
}

/**
 * 应用清单的一句话描述（确认弹窗与结果预览共用）。
 *
 * 三种口径，**空 allow 必须说成「不限制」而不是「什么都不允许」**：
 *   · 两侧都空   ⇒ 不限制（这一项就是普通的能力位）；
 *   · 只有 allow ⇒ 只能操作这些；
 *   · 有 deny    ⇒ 永远排除这些（无论 allow 怎么写）。
 */
export function appsPhrase(apps: GrantAppScope): string {
  const allow = appListPhrase(apps.allow);
  const deny = appListPhrase(apps.deny);
  if (allow === '' && deny === '') return t('grants.apps.describeUnrestricted');
  if (allow === '') return t('grants.apps.describeDenyOnly', { deny });
  if (deny === '') return t('grants.apps.describeAllowOnly', { allow });
  return t('grants.apps.describeBoth', { allow, deny });
}

/** 已授予行的摘要（「允许 2 个程序 · 1 个窗口标题；排除 1 个程序」）。 */
export function appsSummary(apps: GrantAppScope): string {
  const c = appsCounts(apps);
  if (c.total === 0) return t('grants.apps.summaryUnrestricted');
  const parts: string[] = [];
  if (c.allowExes > 0 || c.allowTitles > 0) {
    parts.push(t('grants.apps.summaryAllow', { exes: c.allowExes, titles: c.allowTitles }));
  }
  if (c.denyExes > 0 || c.denyTitles > 0) {
    parts.push(t('grants.apps.summaryDeny', { exes: c.denyExes, titles: c.denyTitles }));
  }
  return parts.join(t('grants.copy.listSep'));
}

/**
 * 就地校验（提交前）：返回 i18n key 与插值参数（不返回拼好的字符串，
 * 因为错误文案必须跟随语言，见 caps.ts 头注的惰性文案纪律）。
 * 返回 null = 通过。
 */
export interface AppsError {
  key: string;
  params: Record<string, string | number>;
}

export function validateAppsDraft(draft: AppsDraft): AppsError | null {
  const p = parseAppsDraft(draft);
  if (p.credential) return { key: 'grants.apps.errCredential', params: {} };
  if (p.tooLong) return { key: 'grants.apps.errEntryTooLong', params: { n: MAX_ENTRY_CHARS } };
  if (p.tooMany) return { key: 'grants.apps.errTooLong', params: { n: MAX_ENTRIES } };
  return null;
}

/** 每侧条数上限（面板提示用；与服务端 MAX_SCOPE_ENTRIES 同口径）。 */
export const APPS_MAX_ENTRIES = MAX_ENTRIES;
/** 单项长度上限（面板提示用）。 */
export const APPS_MAX_ENTRY_CHARS = MAX_ENTRY_CHARS;
