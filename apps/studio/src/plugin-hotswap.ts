/**
 * 插件热插拔：**换代开关**（`docs/feature-plugin-hotswap.md` §3/§4/§5）。
 *
 * 这个模块把三件事收在一处，因为它们是同一个决定的三半：
 *
 *   1. **持久化**（经专用 [SerialQueue]）——两个并发 `PUT` 不能交错 tmp+rename，
 *      否则后到的更新会被先到的覆盖（与 `handlers/display-plugins.ts` 同样的理由）；
 *   2. **拒绝**——停用一个 `required` 行、或者在**有活跃会话**时换 `studio/bus` /
 *      `studio/runtime`，必须**被拒绝并给出原因**，绝不静默忽略（§6.3）；
 *   3. **通知**——写入成功后告诉引擎「换代」，引擎在**下一 turn 边界**重建每一代
 *      （`RuntimeAdapter.invalidateAll()` -> `SessionRuntimeRegistry.invalidateAll()`：
 *      空闲实例立即重组、在跑的 turn 只被**标记**，下一个边界才换）。
 *
 * ## 为什么是「换代」而不是「卸载」（§4）
 *
 * `Context` 没有移除原语，`Plugin` 接口没有 unmount。这不是阻碍：
 * `compose()` 本来就是「一代一 compose」（每次 `Context.root()`），
 * `apps/studio/src/runtime/session-compose.ts` 也写着「compose() for ONE session」。
 * 所以「关掉一个插件」= 下一代 `compose()` 不再 mount 它；活跃的那一代**原地不动**，
 * 跑完自己这一轮，然后被 dispose。绝不原地修改活跃 Context。
 *
 * ## 为什么不能只换单个服务
 *
 * 插件在 `mount()` 里 `ctx.require(dep)` 并把结果**捕获**进自己内部（`studio/sessions`
 * 把 workspaces store 传给 `new SessionsStore(...)`）。只替换 `WORKSPACES_SERVICE`
 * 不会改变 `SessionsStore` 里的引用 → 两个 store 指向不同的世界。唯一安全的做法是
 * 按 mount 顺序重建整代，再原子替换引用——也就是上面那条路。
 */

import { dirname } from "node:path";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import { SerialQueue } from "./serial-queue.js";
import {
  ENGINE_PLUGIN_NAMES,
  enginePluginSwitchesOf,
  pluginCatalog,
  type EnginePluginSwitches,
  type PluginCatalogRow,
  type PluginLayer,
} from "./plugin-catalog.js";
import { nowSec } from "./store/grants-service.js";
import { readPlugins, writePlugins } from "./store/plugins.js";
import { errText } from "./store/result.js";

/** `GET /api/plugins` 的一行：清单 + 当前启用状态。 */
export interface PluginRow extends PluginCatalogRow {
  enabled: boolean;
}

/** 一次 `PUT` 的判定结果。 */
export interface PluginSwitchResult {
  ok: boolean;
  /** `ok:false` 时的原因（HTTP 层的 `error` 字段）。 */
  error?: string;
  /** 这一行不能被停用时的名字（`required`）。 */
  plugin?: string;
  /** 换 `studio/bus`/`studio/runtime` 时正在跑的会话（`idle-only`）。 */
  busy_sessions?: string[];
  /** 相对上一次的差集（`ok:true` 时）。 */
  disabled?: string[];
  enabled?: string[];
  /** 是否真的变了（没变就不会通知引擎换代）。 */
  changed?: boolean;
}

/** `PUT /api/plugins` 的请求体（两个字段都是可选的，缺省 = 保留原值）。 */
export interface PluginSwitchPatch {
  /** 替换整张停用表。 */
  disabled?: readonly string[];
  /** 替换整张启用表（`disabled` 的补集；两个都给时以 `disabled` 为准）。 */
  enabled?: readonly string[];
}

/** 清单里的引擎层行（`ENGINE_PLUGIN_NAMES` 的投影，含策略）。 */
function engineRows(): PluginCatalogRow[] {
  return pluginCatalog([]).filter((row) => row.layer === "engine");
}

/**
 * 引擎层的停用集合：**只保留引擎层、且策略允许停用**的名字。
 *
 * 这一层过滤是必需的，不是防御性代码：
 *   - 一个手改过的 `plugins.json` 可以提到任何名字；
 *   - 一个**旧版本**的 studio 可能停用过某个后来变成 `required` 的插件。
 * 把这样的名字喂给引擎，只会让 `compose()` 在 mount 中途抛错——那是「配置把人搞挂了」，
 * 而不是「配置生效了」。所以这里按清单过滤，`required` 的行**永远不会**到达引擎。
 */
export function engineDisabledOf(disabled: readonly string[]): string[] {
  const known = new Set(ENGINE_PLUGIN_NAMES);
  const optional = new Set(engineRows().filter((row) => row.disable !== "required").map((row) => row.name));
  return disabled.filter((name) => known.has(name) && optional.has(name));
}

/**
 * 引擎层的停用集合 -> `compose()` 的开关（`SessionComposerOptions` 的子集）。
 * 实现与类型都在 `plugin-catalog.ts`（那条依赖链的叶子），这里只做转发，
 * 让 host 侧的调用点只需要 import 一个模块。
 */
export { enginePluginSwitchesOf, type EnginePluginSwitches } from "./plugin-catalog.js";

/** 换代通知的订阅者（引擎侧注册一次）。 */
export type PluginSwitchListener = (engineDisabled: readonly string[]) => void;

export interface PluginSwitchOptions {
  /** 数据目录（`plugins.json` 所在处，与 workspaces.json 并列）。 */
  dir: string;
  /** `StudioServices.hostPluginNames` —— host 层的真实 mount 记录。 */
  hostNames: () => readonly string[];
  /** 秒级时间戳来源（测试注入固定值）。 */
  now: () => number;
}

/**
 * 进程内唯一的插件开关。**内存里的 `disabled` 是权威**，磁盘只是它的持久化：
 * `GET` 读内存，所以一个刚完成的 `PUT` 绝不会因为 tmp+rename 还没落盘而读回旧值。
 */
export class PluginSwitch {
  private readonly opts: PluginSwitchOptions;
  /** 专用队列：所有写入串行（两个并发 PUT 不丢更新）。 */
  private readonly writes = new SerialQueue();
  private readonly listeners: PluginSwitchListener[] = [];
  /** 权威状态（构造时从磁盘载入）。 */
  private current: string[];
  /** 载入时的降级警告（`GET` 会把它带给客户端）。 */
  readonly loadWarnings: string[];

  constructor(opts: PluginSwitchOptions) {
    this.opts = opts;
    const read = readPlugins(opts.dir);
    this.current = read.disabled;
    this.loadWarnings = read.warnings;
  }

  /** 归一化后的停用表（内存权威）。 */
  disabled(): string[] {
    return [...this.current];
  }

  /** 清单 + 当前启用状态（`GET` 的 body 来源）。 */
  rows(): PluginRow[] {
    const off = new Set(this.current);
    return pluginCatalog(this.opts.hostNames()).map((row) => ({ ...row, enabled: !off.has(row.name) }));
  }

  /** 某一层的行。 */
  rowsOfLayer(layer: PluginLayer): PluginRow[] {
    return this.rows().filter((row) => row.layer === layer);
  }

  /** 引擎层的停用集合（`required` 的行已被滤掉）。 */
  engineDisabled(): string[] {
    return engineDisabledOf(this.current);
  }

  /** 引擎层的装配开关。 */
  engineSwitches(): EnginePluginSwitches {
    return enginePluginSwitchesOf(this.engineDisabled());
  }

  /**
   * 订阅换代通知。返回退订函数（测试用；生产只注册一次）。
   */
  onChange(listener: PluginSwitchListener): () => void {
    this.listeners.push(listener);
    return () => {
      const at = this.listeners.indexOf(listener);
      if (at >= 0) this.listeners.splice(at, 1);
    };
  }

  /**
   * 判定 + 落盘 + 通知。**拒绝发生在这个方法里，而不是处理器里**：
   * 「什么能被关掉」是 catalog 的知识，把它留在处理器里等于复制一份策略。
   *
   * `activeSessions` 由调用方传入（host 侧才有 runtime），用来判 `idle-only`。
   */
  async replace(patch: PluginSwitchPatch, activeSessions: readonly string[]): Promise<PluginSwitchResult> {
    const requested = this.requestedOf(patch);
    if (!requested.ok) return { ok: false, error: requested.error };

    const before = this.current;
    const next = requested.disabled;
    // 差集（用于报告；也决定要不要通知引擎换代）。
    const beforeSet = new Set(before);
    const nextSet = new Set(next);
    const nowDisabled = next.filter((name) => !beforeSet.has(name));
    const nowEnabled = before.filter((name) => !nextSet.has(name));
    const changed = nowDisabled.length > 0 || nowEnabled.length > 0;

    // ① `required`：说出来为什么，绝不静默忽略。
    const refused = pluginCatalog(this.opts.hostNames()).find((row) => row.disable === "required" && nextSet.has(row.name));
    if (refused !== undefined) {
      return {
        ok: false,
        plugin: refused.name,
        error: `plugin '${refused.name}' cannot be disabled: ${refused.reason ?? "it is required by the composition"}`,
      };
    }

    // ② `idle-only`：只有**没有活跃会话**时才能换（§3.2）。判据是「这一次真的动了它」——
    // 保持原值不算换（否则一个幂等的 PUT 会在有会话时莫名其妙地被拒）。
    const touched = pluginCatalog(this.opts.hostNames()).filter(
      (row) => row.disable === "idle-only" && (nowDisabled.includes(row.name) || nowEnabled.includes(row.name)),
    );
    if (touched.length > 0 && activeSessions.length > 0) {
      const names = touched.map((row) => `'${row.name}'`).join(", ");
      const why = touched[0]?.reason ?? "it is a host singleton";
      return {
        ok: false,
        plugin: touched[0]?.name,
        busy_sessions: [...activeSessions],
        error: `cannot change ${names} while ${activeSessions.length} session(s) are active: ${why}`,
      };
    }

    if (!changed) {
      return { ok: true, disabled: next, enabled: [], changed: false };
    }

    try {
      // 串行：第二个 PUT 等第一个的 tmp+rename 落定。
      await this.writes.run(async () => {
        writePlugins(this.opts.dir, next, this.opts.now());
        // 内存权威在同一临界区内更新：`GET` 读内存，所以它永远不会看到
        // 「文件写完了但状态还没换」的中间态。
        this.current = next;
      });
    } catch (e) {
      return { ok: false, error: "cannot persist plugins: " + errText(e) };
    }
    // 换代通知在临界区**之外**：订阅者是引擎（它只标记实例，不做 IO），
    // 而且一个抛错的订阅者绝不能把已经落盘的写入变成一次失败。
    this.notify();
    return { ok: true, disabled: next, enabled: nowEnabled, changed: true };
  }

  /** 把请求体解析成「下一张停用表」（向后兼容：两个字段都可以不发）。 */
  private requestedOf(patch: PluginSwitchPatch): { ok: true; disabled: string[] } | { ok: false; error: string } {
    const known = pluginCatalog(this.opts.hostNames()).map((row) => row.name);
    if (patch.disabled !== undefined && patch.enabled !== undefined) {
      // 两个都给 = 自相矛盾的请求。以 `disabled` 为准（它与磁盘上的形状一致），
      // 但**说出来**：静默挑一个会让客户端以为另一个也生效了。
      const disabled = this.normalize(patch.disabled, known);
      const enabled = this.normalize(patch.enabled, known);
      const contradiction = disabled.find((name) => enabled.includes(name));
      if (contradiction !== undefined) {
        return { ok: false, error: `fields 'disabled' and 'enabled' contradict each other on '${contradiction}'` };
      }
      return { ok: true, disabled };
    }
    if (patch.disabled !== undefined) return { ok: true, disabled: this.normalize(patch.disabled, known) };
    if (patch.enabled !== undefined) {
      const enabled = new Set(this.normalize(patch.enabled, known));
      // `enabled` 是补集：清单里不在启用表里的行 = 停用。这是给「我手上有整张
      // 启用表」的客户端的形状（`GET` 的 `plugins[]` 直接回填即可）。
      return { ok: true, disabled: known.filter((name) => !enabled.has(name)) };
    }
    // 两个字段都没有 = 老客户端「只发它认识的东西」：保留原值（§5 的向后兼容）。
    return { ok: true, disabled: [...this.current] };
  }

  /**
   * 归一化一个客户端给的名单：trim、丢空、去重、保序，并**丢掉清单外的名字**。
   *
   * 清单外的名字只可能是「客户端的清单比服务端新」或者手抄错误。把它写进文件，
   * 只会让一个永远不生效的条目留在磁盘上；丢掉它才是诚实的。
   */
  private normalize(names: readonly string[], known: readonly string[]): string[] {
    const allowed = new Set(known);
    const out: string[] = [];
    for (const raw of names) {
      const name = raw.trim();
      if (name === "" || out.includes(name) || !allowed.has(name)) continue;
      out.push(name);
    }
    return out;
  }

  private notify(): void {
    const engine = this.engineDisabled();
    for (const listener of [...this.listeners]) {
      try {
        listener(engine);
      } catch (e) {
        // 一个坏订阅者不能让一次成功的写入变成失败（同 `compose.ts` 的 onInjected 处理）。
        process.stderr.write(`[celestea-plugin-hotswap] onChange listener failed: ${String(e)}\n`);
      }
    }
  }
}

/** 数据目录：与 workspaces.json / display-plugins.json 并列（同一个推导点）。 */
export function pluginDataDir(workspacesFile: string): string {
  return dirname(workspacesFile);
}

/**
 * 把 `PluginSwitch` 接到引擎的换代通道上。
 *
 * 为什么是 `invalidateAll()` 而不是「立刻重组」：这正是 §3.1 拍板的**turn 边界**
 * 语义，而且它是引擎**已经有**的机制（`RuntimeAdapter.invalidateAll` ->
 * `SessionRuntimeRegistry.invalidateAll`）：空闲实例立即重组，在跑的 turn 只被标记，
 * 下一个边界才换。所以「开关变更不打断正在跑的 turn」不是在这里实现的，
 * 而是复用配置 epoch 那条被测试覆盖过的路径。
 *
 * `invalidateAll` 是可选的（假适配器没有 registry），缺省时静默跳过——
 * 那只是「这个适配器没有代可换」，不是错误。
 */
export function bindPluginSwitchToEngine(switcher: PluginSwitch, runtime: RuntimeAdapter): () => void {
  return switcher.onChange(() => {
    runtime.invalidateAll?.();
  });
}

/** `nowSec` 的再导出：处理器只 import 本模块，不必知道时钟在哪个 store 里。 */
export { nowSec };
