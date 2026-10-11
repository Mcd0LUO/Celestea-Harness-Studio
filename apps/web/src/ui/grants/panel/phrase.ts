// ============================================================================
// ui/grants/panel/phrase.ts — 能力 → 用户语言的固定句式（W760 拆出）。
//
//   纯函数（零 DOM）：结果预览（previewText）与逐项明细的短语（phraseFor）。
//   flow.ts 的二次确认文案也直接用这里的 phraseFor，所以它经 ../panel.ts 原样再导出。
//   W760 只搬家：句式、join 分隔符逐字未改；W773 把 TTL 取值（maxTtlOf / ttlOf）
//   移到 ../request.ts —— 与授予请求体同层，便于机械断言「默认永久」。
// ============================================================================
import type { GrantScope } from '../../../types';
import { caps, listOf, scopeOf, type CapDef } from '../caps';
import { appsOfScope, appsPhrase } from '../apps';
import { t } from '../../../i18n';
import { activeFor, activeGrants, baselineIsFullAccess, effectiveOf } from './active';

/*
 * PX1-2：**「没有任何放宽项」不等于「只能读写工作区」**。
 *   旧实现在这里直接回一句写死的「只能读写工作区目录，不能访问网络」，而默认档位
 *   （full-access）在真机上的 effective 是 `network:true, read_roots:["/"],
 *   write_roots:["/"]` —— 一句反着说的话，让用户据此放心让 agent 跑命令。
 *   现在由 effective 驱动：整机可读写+可联网 / 未知 / 真正的工作区受限 三种口径。
 */
/**
 * 基线口径的一句话（没有额外放宽项时说什么）。由生效快照决定，绝不写死。
 * 额外放宽项存在时走下面的 canNow 句式，基线则作为前缀说明保留。
 */
function baselinePhrase(): string {
  if (baselineIsFullAccess()) return t('grants.phrase.defaultFull');
  return effectiveOf() === null ? t('grants.phrase.defaultUnknown') : t('grants.phrase.default');
}

/** 当前生效集 → 一句话预览（固定常量句式，范围值只作数据填入）。 */
export function previewText(): string {
  const active = activeGrants();
  if (!active.length) return baselinePhrase();
  const parts: string[] = [];
  for (const def of caps()) {
    const g = activeFor(def.cap);
    if (!g) continue;
    parts.push(phraseFor(def, scopeOf(g)));
  }
  if (!parts.length) return baselinePhrase();
  return t('grants.phrase.canNow') + parts.join(t('grants.copy.listSep')) + t('grants.phrase.suffix');
}

/** 单项能力的「可以做什么」短语（固定句式 + 范围数据）。 */
export function phraseFor(def: CapDef, scope: GrantScope): string {
  switch (def.cap) {
    case 'network':
      return t('grants.phrase.network');
    case 'write_roots':
      return t('grants.phrase.writeRoots', { roots: listOf(scope.roots).join(t('grants.copy.listSep')) });
    case 'read_roots':
      return t('grants.phrase.readRoots', { roots: listOf(scope.roots).join(t('grants.copy.listSep')) });
    case 'net_hosts':
      return t('grants.phrase.netHosts', { hosts: listOf(scope.hosts).join(t('grants.copy.listSep')) });
    case 'tool_extra':
      return t('grants.phrase.toolExtra', { tools: listOf(scope.tools).join(t('grants.copy.listSep')) });
    case 'unsandboxed':
      return t('grants.phrase.unsandboxed');
    case 'desktop': {
      // M2-B2a：带应用清单时把清单口径说进预览句（空清单 = 不限制，逐字沿用原文案）。
      const apps = appsOfScope(scope);
      return apps.allow === undefined && apps.deny === undefined
        ? t('grants.phrase.desktop')
        : t('grants.phrase.desktopScoped', { apps: appsPhrase(apps) });
    }
  }
}

