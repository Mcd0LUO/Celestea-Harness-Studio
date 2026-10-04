/**
 * 插件热插拔（`docs/feature-plugin-hotswap.md`）：**两层插件清单 + 换代开关**（2 个端点）。
 *
 *   GET /api/plugins -> `{ok:true, plugins:[{name,layer,hot,enabled,...}], disabled:[...]}`
 *   PUT /api/plugins -> 替换启用表，body 与 GET 同形（`disabled` / `enabled` 二选一）
 *
 * ## W860 的边界在这里被**有意**打开（§1/§2）
 *
 * W860 只列 host 启动层的 8 个注入 token，并且把 `hot` 硬编码成 `false`；真正的功能
 * 插件（工具、worker、swarm、watchdog）由引擎每会话装配，被 `plugins.ts` 的边界注释
 * 刻意排除。结果是设置页的「插件」一格只显示 `studio/workspaces` 这类服务 token，
 * 用户认得出的功能一个都不在里面。现在两层一起列，`hot` 逐行如实（见
 * `plugin-catalog.ts` 的文件头：`hot` 是「按代重新装配」，`disable` 才是「能不能关」）。
 *
 * ## 形状对齐 `GET/PUT /api/display-plugins`（W895-C1 / W9108）
 *
 * 同样的「服务端是唯一真源」、同样的 `disabled: string[]` 存储语义（新插件默认开）、
 * 同样的**专用 [SerialQueue]**（两个并发 PUT 不能交错 tmp+rename）、以及同样的
 * **双向向后兼容**：老客户端不发某个字段 => 该字段保留原值。
 *
 * 一处**有意**的差别：display-plugins 对 id 是**不透明**的（哪些组件存在是前端的知识），
 * 而这里服务端**知道**装配清单——因为清单就是它自己 mount 的东西。所以：
 *   - 清单外的名字在写入时被丢弃（一个永远不生效的条目不该落盘）；
 *   - 停用一个 `required` 行 = **422 + 原因**，不是静默忽略；
 *   - 有活跃会话时换 `studio/bus`/`studio/runtime` = **409 + 原因 + busy_sessions**。
 *
 * 标签与提示是前端 i18n，不走这个端点（与 display-plugins 同一条边界）。
 */

import type { Hono } from "hono";
import { MAX_DISABLED_PLUGINS } from "../store/plugins.js";
import type { RouteTable } from "../routes.js";
import type { Deps } from "./common.js";
import { failJson, readJsonBody } from "./common.js";

/** 一个字符串数组字段：`undefined` = 客户端没发（保留原值）。 */
type ArrayField = { ok: true; value: string[] | undefined } | { ok: false; error: string };

function arrayField(raw: unknown, name: string): ArrayField {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
    return { ok: false, error: `field '${name}' must be an array of strings` };
  }
  const values = raw as string[];
  if (values.some((id) => id.trim() === "")) return { ok: false, error: `field '${name}' must not contain an empty name` };
  // 与 `store/plugins.ts` 的 MAX_DISABLED_PLUGINS 同一条上限：HTTP 面直接拒掉超长表，
  // 而不是让每次读都退化成 O(n²)（`normalize` 用 includes 去重）。
  if (values.length > MAX_DISABLED_PLUGINS) {
    return { ok: false, error: `field '${name}' must hold at most ${MAX_DISABLED_PLUGINS} names` };
  }
  return { ok: true, value: values };
}

/** 两个端点共用的响应体（一种形状，一处构造）。 */
function bodyOf(deps: Deps): Record<string, unknown> {
  const switcher = deps.plugins;
  return {
    ok: true,
    plugins: switcher.rows(),
    // `disabled` 与 `plugins[].enabled` 是同一件事的两个投影，两个都给：
    // 前者与 display-plugins 同形（老客户端的形状），后者是 `plugins[]` 自带的。
    disabled: switcher.disabled(),
    ...(switcher.loadWarnings.length === 0 ? {} : { warnings: switcher.loadWarnings }),
  };
}

function registerGet(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_plugins");
  app.on(route.method, route.honoPath, (c) => c.json(bodyOf(deps)));
  return route.id;
}

function registerPut(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("put_plugins");
  app.on(route.method, route.honoPath, async (c) => {
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const disabled = arrayField(body.body["disabled"], "disabled");
    if (!disabled.ok) return failJson(c, 422, disabled.error);
    const enabled = arrayField(body.body["enabled"], "enabled");
    if (!enabled.ok) return failJson(c, 422, enabled.error);

    // 活跃会话是 `idle-only` 那两行的判据（§3.2）。判据取「正在跑的 turn」而不是
    // 「有实例」：一个空闲实例本来就会在下一个边界被重组，没有理由拦住它。
    const active = deps.runtime.busySessions();
    const patch = {
      ...(disabled.value === undefined ? {} : { disabled: disabled.value }),
      ...(enabled.value === undefined ? {} : { enabled: enabled.value }),
    };
    const result = await deps.plugins.replace(patch, active);
    if (!result.ok) {
      const status = result.busy_sessions === undefined ? 422 : 409;
      return failJson(c, status, result.error ?? "cannot change plugins", {
        ...(result.plugin === undefined ? {} : { plugin: result.plugin }),
        ...(result.busy_sessions === undefined ? {} : { busy_sessions: result.busy_sessions }),
      });
    }
    return c.json(bodyOf(deps));
  });
  return route.id;
}

export function registerPlugins(app: Hono, deps: Deps, table: RouteTable): string[] {
  return [registerGet(app, deps, table), registerPut(app, deps, table)];
}
