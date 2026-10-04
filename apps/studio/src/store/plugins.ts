/**
 * 插件热插拔：服务端「停用表 + 显式启用表」的持久化层（`docs/feature-plugin-hotswap.md` §5）。
 *
 * 与 `store/display-plugins.ts`（W895-C1 / W9108）同形、**存储层独立**：
 * 那个文件是「显示组件」的启用表，这个文件是「装配插件」的启用表，两者的 id 空间
 * 完全不同（`studio/workspaces` vs 前端组件 id），所以共用文件会让一次显示组件
 * 的开关把插件的开关整表覆盖掉。
 *
 * ## 存的是 disabled 集合，外加一个 W9331 起才有的 `enabled` 集合
 *
 * 原来的语义**刻意**是「新加的插件默认是开的」：旧文件根本不会提到它，所以它自动
 * 启用。W9331 要把 `celestea.runtime.swarm` 改成**默认关**，于是出现了这个 store
 * 无法表达的状态：
 *
 *   - 停用表只存 disabled，所以**不在表里同时意味着「默认开」**；
 *   - 一旦某一行默认关，「用户打开了它」就**没有表示法**——打开 = 不在 disabled 里，
 *     而「不在 disabled 里」和「从没被配置过」是同一个字节。
 *
 * 所以停用表**继续只存 disabled**（旧文件原样可读，语义一字未改），另加一个
 * `enabled` 数组表示「对**默认关**的插件的显式打开」。两个集合的交集是**矛盾**，
 * 读的时候 `disabled` 胜出（与 `plugin-hotswap.ts` 的 PUT 契约同一条规则）。
 * 有效停用集合 =（store 的 disabled）∪（目录里 `defaultEnabled === false` 且**不在**
 * store 的 enabled 里）——这个合成发生在 `plugin-hotswap.ts`，因为「哪些插件默认关」
 * 是 catalog 的知识，不是数据的知识。
 *
 * ## 版本
 *
 * `version: 1`（W9322 原样，**不带** `enabled` 键）与 `version: 2`（本文件新增，
 * 同时带 `disabled` 与 `enabled`）**都接受**。写出一律用 v2。旧的 v1 文件读起来与
 * 之前逐字节同义：`enabled` 缺失 = 空数组 = 「没有任何插件被显式打开」。
 *
 * 同一条纪律（与 `store/session-tools.ts` / `store/display-plugins.ts` 一致）：
 * 白名单 + 校验 + 原子写；损坏/陌生的文件 = 「什么都没被停用」+ 一条 warning，
 * 绝不「修复」。
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

/**
 * 当前写出的文件版本。**1 仍然被读**（W9331 之前所有现场文件都是 v1），所以升级
 * 不需要任何迁移步骤：旧文件原样可读，第一次写入才变成 v2。
 */
export const PLUGINS_FILE_VERSION = 2;

export interface PluginsRead {
  /** 归一化后的停用名字；文件不存在或不可用时为空。 */
  disabled: string[];
  /**
   * 归一化后的**显式启用**名字（W9331）。只对「目录里 `defaultEnabled === false`」
   * 的行有意义，但对所有行都是合法的存储：它只是「用户明确要求开着」的一个集合。
   */
  enabled: string[];
  /**
   * 文件为什么被忽略。最多一条，且它总是意味着「所有**默认开**的插件都是启用的」
   * （与 `readSessionTools` / `readDisplayPlugins` 同样的「降级 + 说出来」契约）。
   */
  warnings: string[];
}

/**
 * 唯一的归一化函数：trim、丢空、去重、保首次出现顺序、截断到上限。
 *
 * PUT 端点先校验原始数组（非字符串或空白 = 422）；手写文件在**读**的时候走
 * 同一个函数，那里的空白条目只是被丢掉。
 *
 * 两个集合共用它：dedupe 的成本同为 O(n²)，上限同理，所以「同一个函数、同一条
 * 上限」比两个几乎一样的函数更诚实——它们本来就是同一件事。
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
 * 读 + 校验；**永不抛**。文件不存在 = `{disabled: [], enabled: [], warnings: []}`
 * 且无 warning（旧字节）；损坏的文件 = 两个空表 + 一条说明「所有插件都是启用的」
 * warning。
 *
 * **向后兼容的读**（W9331）：
 *   - `version: 1` —— 必须带字符串数组的 `disabled`；`enabled` 缺省 = 空数组。
 *   - `version: 2` —— 两个数组都必须带，且都必须是字符串数组。
 *
 * 两种情况下的降级方向都是**fail-safe**：解析不出来时两个集合都空，而
 * 「两个集合都空」= 所有**默认开**的插件都开、所有**默认关**的插件都关。也就是说，
 * 一个损坏的文件既不会偷偷打开一个用户明确关掉的插件，也不会偷偷关掉一个默认关的
 * 保护性插件——它回到**目录的默认值**。
 */
export function readPlugins(dir: string): PluginsRead {
  const out = readJsonIfExists(join(dir, PLUGINS_FILE));
  if (!out.exists) return { disabled: [], enabled: [], warnings: [] };
  const voided = (reason: string): PluginsRead => ({
    disabled: [],
    enabled: [],
    warnings: ["plugins_unreadable: " + reason + " — every default-enabled plugin is enabled"],
  });
  if (out.error !== undefined) return voided("unparsable plugins.json: " + out.error);
  const value = out.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return voided("plugins.json is not an object");
  const rec = value as Record<string, unknown>;
  const version = rec["version"];
  if (version !== 1 && version !== PLUGINS_FILE_VERSION) {
    return voided("unknown plugins.json version " + JSON.stringify(version));
  }
  const raw = rec["disabled"];
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
    return voided("plugins.json has no `disabled` array of strings");
  }
  const disabled = normalizeDisabledPlugins(raw as string[]);
  // v1 根本没有这个键；v2 缺它或形状不对都按「空」读——**不**因此丢掉一份已经读懂的
  // 停用表。理由：这份表已经通过校验，而「enabled 读不出来」只影响默认关的行，把
  // 两者一起作废会让一个手滑的文件把**用户关掉的插件全部打开**（危险方向）。
  const rawEnabled = rec["enabled"];
  const enabled = Array.isArray(rawEnabled) && !rawEnabled.some((id) => typeof id !== "string") ? normalizeDisabledPlugins(rawEnabled as string[]) : [];
  if (version === PLUGINS_FILE_VERSION && !Array.isArray(rawEnabled)) {
    // 说出来：v2 声称有两张表却少了一张，是一份手改过的文件。
    return {
      disabled,
      enabled,
      warnings: ["plugins_partial: plugins.json declares version 2 but has no `enabled` array — it reads as empty"],
    };
  }
  return { disabled, enabled, warnings: [] };
}

/** 归一化 + 原子写；返回真正落盘的那张停用表。 */
export function writePlugins(
  dir: string,
  disabled: readonly string[],
  now: number,
  enabled: readonly string[] = [],
): string[] {
  const normalized = normalizeDisabledPlugins(disabled);
  writeJsonAtomic(
    join(dir, PLUGINS_FILE),
    {
      version: PLUGINS_FILE_VERSION,
      disabled: normalized,
      enabled: normalizeDisabledPlugins(enabled),
      updated_at: now,
    },
    { mode: 0o644 },
  );
  return normalized;
}
