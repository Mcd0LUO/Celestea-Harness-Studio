/**
 * 插件热插拔：服务端「停用表」的持久化层（`docs/feature-plugin-hotswap.md` §5）。
 *
 * 与 `store/display-plugins.ts`（W895-C1 / W9108）同形、**存储层独立**：
 * 那个文件是「显示组件」的启用表，这个文件是「装配插件」的启用表，两者的 id 空间
 * 完全不同（`studio/workspaces` vs 前端组件 id），所以共用文件会让一次显示组件
 * 的开关把插件的开关整表覆盖掉。
 *
 * 存的是 **disabled 集合**（不是 enabled 集合），沿用 display-plugins 的产品语义：
 * 「新加的插件默认是开的」——旧文件根本不会提到它，所以它自动是启用的。
 *
 * 与 display-plugins 的一处**有意差别**：这里的名字必须真实存在于装配清单里，
 * 否则调用方就会拿到一个「停用了但永远不生效」的条目。因此
 * `normalizeDisabledPlugins` 只做 trim / 去空 / 去重 / 保序，**是否在清单里由
 * `plugin-hotswap.ts` 用 catalog 过滤**（读一个手改过的文件时，未知名字被静默
 * 丢弃并计一条 warning；写入路径则不会把它写进文件）。
 *
 * 同一条纪律（与 `store/session-tools.ts` / `store/display-plugins.ts` 一致）：
 * 白名单 + 校验 + 原子写；损坏/陌生的文件 = 「没有任何插件被停用」，绝不「修复」。
 */

import { join } from "node:path";
import { readJsonIfExists, writeJsonAtomic } from "./fs-json.js";

/** 数据文件，与 workspaces.json / providers.json / display-plugins.json 并列。 */
export const PLUGINS_FILE = "plugins.json";

/**
 * 停用表的条数上限。
 *
 * 与兄弟上限同量级（`MAX_SESSION_DISABLED_TOOLS` = 64，preset `toolDeny` = 64，
 * grant scope = 32）。装配清单本身只有十几行，所以 64 足够宽松；上限存在的
 * 意义是「一个被灌爆的文件不能让每次读都退化成 O(n²)」——`normalize` 用
 * `includes` 去重，列表越长越贵。
 */
export const MAX_DISABLED_PLUGINS = 64;

export interface PluginsRead {
  /** 归一化后的停用名字；文件不存在或不可用时为空。 */
  disabled: string[];
  /**
   * 文件为什么被忽略。最多一条，且它总是意味着「所有插件都是启用的」
   * （与 `readSessionTools` / `readDisplayPlugins` 同样的「降级 + 说出来」契约）。
   */
  warnings: string[];
}

/**
 * 唯一的归一化函数：trim、丢空、去重、保首次出现顺序、截断到上限。
 *
 * PUT 端点先校验原始数组（非字符串或空白 = 422）；手写文件在**读**的时候走
 * 同一个函数，那里的空白条目只是被丢掉。
 */
export function normalizeDisabledPlugins(disabled: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of disabled) {
    if (out.length >= MAX_DISABLED_PLUGINS) break;
    const name = value.trim();
    if (name === "" || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/**
 * 读 + 校验；**永不抛**。文件不存在 = `{disabled: []}` 且无 warning（旧字节）；
 * 损坏的文件 = 空表 + 一条说明「所有插件都是启用的」的 warning。
 */
export function readPlugins(dir: string): PluginsRead {
  const out = readJsonIfExists(join(dir, PLUGINS_FILE));
  if (!out.exists) return { disabled: [], warnings: [] };
  const voided = (reason: string): PluginsRead => ({
    disabled: [],
    warnings: ["plugins_unreadable: " + reason + " — every plugin is enabled"],
  });
  if (out.error !== undefined) return voided("unparsable plugins.json: " + out.error);
  const value = out.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return voided("plugins.json is not an object");
  const rec = value as Record<string, unknown>;
  if (rec["version"] !== 1) return voided("unknown plugins.json version " + JSON.stringify(rec["version"]));
  const raw = rec["disabled"];
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
    return voided("plugins.json has no `disabled` array of strings");
  }
  return { disabled: normalizeDisabledPlugins(raw as string[]), warnings: [] };
}

/** 归一化 + 原子写；返回真正落盘的那张表。 */
export function writePlugins(dir: string, disabled: readonly string[], now: number): string[] {
  const normalized = normalizeDisabledPlugins(disabled);
  writeJsonAtomic(
    join(dir, PLUGINS_FILE),
    { version: 1, disabled: normalized, updated_at: now },
    { mode: 0o644 },
  );
  return normalized;
}
