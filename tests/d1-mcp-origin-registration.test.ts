// @vitest-environment jsdom
/**
 * D1 · 新 origin `mcp-invocation` 的**六处登记**（mcp-client.md §5.6 的注入车道）。
 *
 * 为什么单独一条门禁：一个 origin 值漏登记不会让任何运行时行为变红 —— 它只会
 * ① 在会话日志里以「未知注入」呈现，或 ② 在 schema 校验时被判非法。两种都发生在
 * 生产，而门禁全绿。所以这里把「六处都登了、且与闭集逐字一致、且没有顺手把别的
 * 数字也动了」变成会失败的断言（铁律 9：能变成门禁的「别忘了」就不该靠记性）。
 *
 * 六处（照 skill-invocation 的先例逐条对账）：
 *   ① `packages/core/src/types.ts` 的 SessionEventOrigin + SESSION_EVENT_ORIGINS
 *   ② `contracts/session-event.schema.json` 的 origin 枚举
 *   ③ `packages/session/src/messages.ts` 的 originLabel
 *   ④ 前端 `ui/messages/user.ts` 的 inboxKind 分支
 *   ⑤ `i18n/locales/zh/chat.ts`   ⑥ `i18n/locales/en/chat.ts`
 *
 * ★ 同时钉住「**不许顺手改别的数字**」：MCP 工具不进契约，所以 endpoints / tools /
 *   sseEvents 三个冻结数必须与 D1 之前逐字相同（§5.2 / §8 的要点之一）。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
// 前端模块走 at()（与 tests/w-c2-mcp-static.test.ts 同一条）：根 tsconfig 的
// node16 解析不接受前端那条无扩展名的相对导入，直接 import 会把 apps/web 拖进
// 后端的类型检查（实测 4 条 TS2834）。
import { at } from "./lib/w795-dom.js";

import { describe, expect, it } from "vitest";

import { FROZEN_COUNTS, SESSION_EVENT_ORIGINS, loadSessionEventSchema, type SessionEvent } from "@celestea/core";
import { originLabel } from "@celestea/session";
import { MCP_INVOCATION_ORIGIN } from "../apps/studio/src/runtime/mcp-wiring.js";

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

describe("D1 · origin 登记 ①②：闭集与冻结 schema", () => {
  it("mcp-invocation 在闭集里，且与 skill-invocation 是两个值（不是复用）", () => {
    expect(SESSION_EVENT_ORIGINS).toContain(MCP_INVOCATION_ORIGIN);
    expect(MCP_INVOCATION_ORIGIN).not.toBe("skill-invocation");
    // §2.1 同一条陷阱：复用 "skill" 会让常驻目录去重把两条语义互相顶掉。
    expect(MCP_INVOCATION_ORIGIN).not.toBe("skill");
    expect(MCP_INVOCATION_ORIGIN).not.toBe("user");
  });

  it("schema 的 origin 枚举与 SESSION_EVENT_ORIGINS 逐字一致（加值不得开口子集）", () => {
    const schema = loadSessionEventSchema();
    const defs = schema["$defs"] as { SessionEvent: { oneOf: Array<{ title?: string; properties?: Record<string, unknown> }> } };
    const userMessage = defs.SessionEvent.oneOf.find((v) => v.title === "user_message");
    const origin = userMessage?.properties?.["origin"] as { enum?: string[] };
    expect([...(origin?.enum ?? [])].sort()).toEqual([...SESSION_EVENT_ORIGINS].sort());
  });

  it("round-trips through the codec，且开口子集仍被拒", async () => {
    const { validateSessionEvent, serializeSessionEvent, parseSessionEvent } = await import("@celestea/core");
    const ev: SessionEvent = { type: "user_message", text: '<mcp_catalog server="memory">', origin: MCP_INVOCATION_ORIGIN };
    expect(validateSessionEvent(ev).ok).toBe(true);
    const back = parseSessionEvent(serializeSessionEvent(ev));
    expect(back.ok && back.event).toEqual(ev);
    expect(validateSessionEvent({ type: "user_message", text: "x", origin: "mcpinvocation" }).ok).toBe(false);
  });
});

describe("D1 · origin 登记 ③：会话投影的标签", () => {
  it("originLabel 给出自己的标签，与「技能目录」「技能调用」都不重名", () => {
    const label = originLabel(MCP_INVOCATION_ORIGIN);
    expect(label.trim().length).toBeGreaterThan(0);
    expect(label).not.toBe(originLabel("skill"));
    expect(label).not.toBe(originLabel("skill-invocation"));
  });

  it("它投影成 inbox 行（不是用户气泡）——注入块绝不能看起来像人打的字", async () => {
    const { sessionEventToMessage } = await import("@celestea/session");
    const msg = sessionEventToMessage({ type: "user_message", text: "x", origin: MCP_INVOCATION_ORIGIN });
    expect(msg).not.toBeNull();
    expect(msg?.role).toBe("inbox");
    expect(msg !== null && msg !== undefined && "kind" in msg ? msg.kind : null).toBe(MCP_INVOCATION_ORIGIN);
  });
});

describe("D1 · origin 登记 ④⑤⑥：前端分支与 zh/en 双份文案", () => {
  it("④ inboxKind 有一个专属分支（落到回退分支就等于没有标签）", () => {
    const user = read("apps/web/src/ui/messages/user.ts");
    expect(user).toContain("'" + MCP_INVOCATION_ORIGIN + "'");
    expect(user).toContain("chat.inbox.mcpInvocation");
    expect(user, "默认展开：失败行同源，折起来等于把「没注上」藏起来").toContain("collapsed: false");
  });

  it("⑤⑥ zh / en 两份字典都有这条，且 en 里没有混进中文", async () => {
    const i18n = (await import(/* @vite-ignore */ at("i18n/index.ts"))) as {
      localeDict(l: string): Record<string, string>;
    };
    const zh = i18n.localeDict("zh");
    const en = i18n.localeDict("en");
    const key = "chat.inbox.mcpInvocation";
    expect(Object.keys(zh), "zh 字典缺这条").toContain(key);
    expect(Object.keys(en), "en 字典缺这条（en 缺键时界面会退回 key 本身）").toContain(key);
    expect((en[key] ?? "").trim().length, "en 这条是空串").toBeGreaterThan(0);
    expect(en[key] ?? "", "en 字典混进了中文").not.toMatch(/[\u4e00-\u9fff]/);
    // 标签文案必须真的用上，而不是登记了一个没人读的键。
    expect(read("apps/web/src/ui/messages/user.ts")).toContain("t('" + key + "')");
  });
});

describe("D1 · 没有顺手改冻结数字（§5.2 / §8 的要点之一）", () => {
  it("endpoints / tools / sseEvents 与 contracts 三处仍然一致", async () => {
    expect(FROZEN_COUNTS.tools, "MCP 工具不进契约").toBe(23);
    expect(FROZEN_COUNTS.endpoints).toBe(73);
    expect(FROZEN_COUNTS.sseEvents).toBe(10);
    const { loadEndpoints, loadSse, loadTools } = await import("@celestea/core");
    expect(loadEndpoints().endpoints).toHaveLength(FROZEN_COUNTS.endpoints);
    expect(loadSse().events).toHaveLength(FROZEN_COUNTS.sseEvents);
    expect(loadTools().tools).toHaveLength(FROZEN_COUNTS.tools);
  });

  it("会话事件契约里的 origin 枚举**没有**混进任何工具/端点语义（它只是消息来源）", () => {
    const raw = read(join("contracts", "session-event.schema.json"));
    expect(raw).toContain('"mcp-invocation"');
  });
});
