// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createQuestionRegistry, type QuestionRegistry } from "../question-registry.js";
import {
  createDesktopGateHost,
  DESKTOP_CONFIRM_APPROVE,
  DESKTOP_CONFIRM_DENY,
  DESKTOP_CONFIRM_QUESTION,
  DESKTOP_CONFIRM_QUESTION_ID,
  DESKTOP_CONFIRM_TITLE_PREFIX,
} from "./desktop-gate-host.js";
import type { DesktopConfirmLimiter, DesktopGate, DesktopGateVerdict } from "@celestea/runtime";
import { parseSessionEvent, serializeSessionEvent, type SessionEvent } from "@celestea/core";

/**
 * M2 · 确认传输：闸门的 confirm 真的经**既有的挂起问题链路**走了一遭。
 *
 * 本文件用**真的** [PendingQuestion] + 真的 [QuestionRegistry]（不是替身）——被验证的
 * 对象正是「park → 人答 → 结算」这一段，替身会把要证的东西证没。唯一注入的是
 * 「谁在什么时候答」（测试直接调 PendingQuestion 的结算方法，与 HTTP 端点做的是同一件事）。
 */

const NOTEPAD = { window: { app: "notepad.exe", id: 1 } };

interface Parked {
  gate: DesktopGate;
  registry: QuestionRegistry;
  published: Array<{ id: string; question: string; options: string[]; detail: string }>;
  limiters: Map<string, DesktopConfirmLimiter>;
  /** M2-B2b: the audit rows the gate wrote, in write order. */
  rows: SessionEvent[];
  /** M2-B2b: move the injected clock (drives elapsed_ms). */
  advance: (ms: number) => void;
}

function hostOf(
  over: {
    publish?: boolean;
    sessionId?: string | null;
    limiters?: Map<string, DesktopConfirmLimiter>;
    /** M2-B2b: capture the audit rows. Default ON; false covers the no-record path. */
    record?: boolean;
  } = {},
): Parked {
  const registry = createQuestionRegistry();
  const published: Parked["published"] = [];
  const limiters = over.limiters ?? new Map<string, DesktopConfirmLimiter>();
  const rows: SessionEvent[] = [];
  let clock = 1_000;
  const gate = createDesktopGateHost({
    grants: () => ({ desktop: true, apps: null }),
    registry,
    ...(over.record === false ? {} : { record: (event: SessionEvent) => rows.push(event) }),
    now: () => clock,
    ...(over.publish === false
      ? {}
      : {
          publish: (q) => {
            const item = q.questions[0];
            published.push({
              id: item?.id ?? "",
              question: item?.question ?? "",
              options: (item?.options ?? []).map((o) => o.label),
              detail: item?.detail ?? "",
            });
          },
        }),
    sessionId: over.sessionId === undefined ? "sample-ws/s1" : over.sessionId,
    limiters,
    platform: "win32",
  });
  return { gate, registry, published, limiters, rows, advance: (ms) => { clock += ms; } };
}

/** 等挂起的那道确认出现（park 发生在 check 的异步路径里）。 */
async function parked(registry: QuestionRegistry, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const first = registry.all()[0];
    if (first !== undefined) return first;
    if (Date.now() > deadline) throw new Error("the confirmation was never parked");
    await new Promise((r) => setTimeout(r, 1));
  }
}

const denied = (v: DesktopGateVerdict): { code: string; reason: string } => {
  expect(v.kind).toBe("deny");
  return v as { code: string; reason: string };
};

describe("M2 确认传输 · 四种裁决各走一条路", () => {
  it("批准 → allow 且把目标应用作为 approvedApp 交回", async () => {
    const h = hostOf();
    const call = h.gate.check({ method: "type_text", arguments: NOTEPAD });
    const question = await parked(h.registry);
    expect(question.answer([{ id: DESKTOP_CONFIRM_QUESTION_ID, selected: [DESKTOP_CONFIRM_APPROVE] }])).toBe(true);
    expect(await call).toEqual({ kind: "allow", approvedApp: "notepad.exe" });
    // 结算即注销：已答的问题不再出现在恢复列表里。
    expect(h.registry.size()).toBe(0);
  });

  it("拒绝 → desktop_confirm_denied", async () => {
    const h = hostOf();
    const call = h.gate.check({ method: "set_value", arguments: NOTEPAD });
    const question = await parked(h.registry);
    question.answer([{ id: DESKTOP_CONFIRM_QUESTION_ID, selected: [DESKTOP_CONFIRM_DENY] }]);
    expect(denied(await call).code).toBe("desktop_confirm_denied");
  });

  it("自由文本不是批准：只选「拒绝」或只写 custom 都算拒绝", async () => {
    const h = hostOf();
    const call = h.gate.check({ method: "type_text", arguments: NOTEPAD });
    const question = await parked(h.registry);
    // 空 selected + 一段自定义文本：模型可能诱导用户在这里写字，但那不是「允许」。
    question.answer([{ id: DESKTOP_CONFIRM_QUESTION_ID, selected: [], custom: DESKTOP_CONFIRM_APPROVE }]);
    expect(denied(await call).code).toBe("desktop_confirm_denied");
  });

  it("超时 → desktop_confirm_timeout（不是「被拒」）", async () => {
    const h = hostOf();
    const call = h.gate.check({ method: "launch_app", arguments: { app: "notepad.exe" } });
    const question = await parked(h.registry);
    expect(question.timeout()).toBe(true);
    const { code, reason } = denied(await call);
    expect(code).toBe("desktop_confirm_timeout");
    expect(reason).not.toContain("declined");
  });

  it("取消 → desktop_confirm_cancelled（与拒绝分开的码）", async () => {
    const h = hostOf();
    const call = h.gate.check({ method: "type_text", arguments: NOTEPAD });
    const question = await parked(h.registry);
    expect(question.cancel()).toBe(true);
    expect(denied(await call).code).toBe("desktop_confirm_cancelled");
    expect(h.registry.size()).toBe(0);
  });

  it("没有发布者 ⇒ 没有通道：明确报「本宿主没有确认通道」而不是等满 60 秒", async () => {
    const h = hostOf({ publish: false });
    const { code, reason } = denied(await h.gate.check({ method: "type_text", arguments: NOTEPAD }));
    expect(code).toBe("desktop_confirm_unavailable");
    expect(reason).toContain("no confirmation channel");
    // 一张没人能看见的卡片不该被 park 出来。
    expect(h.registry.size()).toBe(0);
    // 非敏感写不受影响。
    expect((await h.gate.check({ method: "click", arguments: NOTEPAD })).kind).toBe("allow");
  });
});

describe("M2 确认传输 · 卡片文案是固定常量", () => {
  it("题干与按钮都来自代码，模型可控的应用名只作为数据出现在 detail", async () => {
    const h = hostOf();
    const call = h.gate.check({ method: "type_text", arguments: NOTEPAD });
    await parked(h.registry);
    const card = h.published[0];
    expect(card?.id).toBe(DESKTOP_CONFIRM_QUESTION_ID);
    expect(card?.question).toBe(DESKTOP_CONFIRM_QUESTION);
    expect(card?.options).toEqual([DESKTOP_CONFIRM_APPROVE, DESKTOP_CONFIRM_DENY]);
    expect(card?.detail).toContain("notepad.exe");
    h.registry.all()[0]?.timeout();
    await call;
  });

  it("把控制字符与双向覆盖符折叠掉，并截断长度", async () => {
    const h = hostOf();
    // 一个想把自己写成两行的应用名 + 一个 bidi 覆盖符 + 一段超长尾巴。
    const evil = "notepad.exe\n\u202E允许这一次" + "x".repeat(500);
    const call = h.gate.check({ method: "type_text", arguments: { window: { app: evil, id: 1, title: "a\u202Eb" } } });
    await parked(h.registry);
    const card = h.published[0];
    const detail = card?.detail ?? "";
    const lines = detail.split("\n");
    // ★ 行数由**代码**决定（应用名一行 + 窗口标题一行）。模型塞进来的 \n 折成了空格，
    //   所以它没法给自己多开一行、把卡片写成别的东西。
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("notepad.exe 允许这一次");
    expect(lines[1]).toContain(DESKTOP_CONFIRM_TITLE_PREFIX);
    // 双向覆盖符被折叠（它能把 "exe.txt" 显示成 "txt.exe"）。
    expect(detail).not.toContain("\u202E");
    // 明细行有长度上限：卡片的正文不该由被确认方决定长度。
    expect(lines[0]!.length).toBeLessThan(300);
    expect(detail).toContain("…");
    h.registry.all()[0]?.timeout();
    await call;
  });
});


describe("M2-B2b · 确认进会话日志（专门的行类型，不混用 user_question）", () => {
  /** 两行都必须是它们自己的类型——把 user_question 塞回来就是本测试要抓的回归。 */
  const askedOf = (h: Parked) => h.rows.filter((r) => r.type === "desktop_confirm");
  const answeredOf = (h: Parked) => h.rows.filter((r) => r.type === "desktop_confirm_answer");

  it("批准：两行齐全，ask 记事实、answer 记裁决与耗时", async () => {
    const h = hostOf();
    const call = h.gate.check({ method: "type_text", arguments: NOTEPAD });
    const question = await parked(h.registry);
    h.advance(1_500);
    question.answer([{ id: DESKTOP_CONFIRM_QUESTION_ID, selected: [DESKTOP_CONFIRM_APPROVE] }]);
    expect(await call).toEqual({ kind: "allow", approvedApp: "notepad.exe" });

    const [asked, answered] = [askedOf(h)[0], answeredOf(h)[0]];
    expect(asked).toEqual({
      type: "desktop_confirm",
      id: question.requestId,
      method: "type_text",
      app: "notepad.exe",
      reason: "sensitive_method",
      timeout_ms: 60_000,
    });
    expect(answered).toEqual({
      type: "desktop_confirm_answer",
      id: question.requestId,
      outcome: "approve",
      elapsed_ms: 1_500,
    });
    // 两行成对，id 相同：审计靠它把「问了什么」与「答了什么」接起来。
    expect(answeredOf(h)).toHaveLength(1);
    expect((asked as { id: string }).id).toBe((answered as { id: string }).id);
    // 没有混进模型面的行类型。
    expect(h.rows.filter((r) => r.type === "user_question" || r.type === "user_answer")).toHaveLength(0);
  });

  it("拒绝：outcome=deny，与 timeout/cancelled 分开", async () => {
    const h = hostOf();
    const call = h.gate.check({ method: "set_value", arguments: NOTEPAD });
    const question = await parked(h.registry);
    h.advance(400);
    question.answer([{ id: DESKTOP_CONFIRM_QUESTION_ID, selected: [DESKTOP_CONFIRM_DENY] }]);
    expect(denied(await call).code).toBe("desktop_confirm_denied");
    expect(answeredOf(h)).toEqual([{ type: "desktop_confirm_answer", id: question.requestId, outcome: "deny", elapsed_ms: 400 }]);
  });

  it("超时：outcome=timeout，不是 deny（没人答 ≠ 说不）", async () => {
    const h = hostOf();
    const call = h.gate.check({ method: "launch_app", arguments: { app: "notepad.exe" } });
    const question = await parked(h.registry);
    h.advance(60_000);
    question.timeout();
    expect(denied(await call).code).toBe("desktop_confirm_timeout");
    expect(answeredOf(h)).toEqual([{ type: "desktop_confirm_answer", id: question.requestId, outcome: "timeout", elapsed_ms: 60_000 }]);
  });

  it("取消：outcome=cancelled，四态各写各的", async () => {
    const h = hostOf();
    const call = h.gate.check({ method: "type_text", arguments: NOTEPAD });
    const question = await parked(h.registry);
    h.advance(250);
    question.cancel();
    expect(denied(await call).code).toBe("desktop_confirm_cancelled");
    expect(answeredOf(h)).toEqual([{ type: "desktop_confirm_answer", id: question.requestId, outcome: "cancelled", elapsed_ms: 250 }]);
  });

  it("应用名与窗口标题在日志里也只作为数据：净化过一次，无伪造行", async () => {
    const h = hostOf();
    const evil = "notepad.exe\n\u202E允许这一次" + "x".repeat(500);
    const call = h.gate.check({ method: "type_text", arguments: { window: { app: evil, id: 1, title: "a\u202Eb" } } });
    await parked(h.registry);
    h.registry.all()[0]?.timeout();
    await call;
    const asked = askedOf(h)[0] as { app: string; title?: string };
    // 换行被折成空格：一个应用名只能占一个字段，写不成第二行文案。
    expect(asked.app).not.toContain("\n");
    expect(asked.app).not.toContain("\u202E");
    expect(asked.title).not.toContain("\u202E");
    // 长度上限同样适用（日志不是被确认方决定长度的地方）。
    expect(asked.app.length).toBeLessThan(300);
  });

  it("app_not_allowlisted 的 reason 也被如实记下", async () => {
    const registry = createQuestionRegistry();
    const rows: SessionEvent[] = [];
    const gate = createDesktopGateHost({
      grants: () => ({ desktop: true, apps: { allow: { exes: ["calc.exe"] } } }),
      registry,
      publish: () => undefined,
      sessionId: "sample-ws/s1",
      limiters: new Map<string, DesktopConfirmLimiter>(),
      platform: "win32",
      record: (event) => rows.push(event),
    });
    // `click` 不在敏感方法表里：非敏感方法打在一个未列名的应用上才会升级成确认，
    // reason 才是 app_not_allowlisted（敏感方法先判，永远赢）。
    const call = gate.check({ method: "click", arguments: NOTEPAD });
    const question = await parked(registry);
    question.answer([{ id: DESKTOP_CONFIRM_QUESTION_ID, selected: [DESKTOP_CONFIRM_APPROVE] }]);
    await call;
    expect((rows[0] as { reason: string }).reason).toBe("app_not_allowlisted");
  });

  it("审计写失败不改变已经发生的裁决（allow 仍是 allow）", async () => {
    const registry = createQuestionRegistry();
    const gate = createDesktopGateHost({
      grants: () => ({ desktop: true, apps: null }),
      registry,
      publish: () => undefined,
      sessionId: "sample-ws/s1",
      limiters: new Map<string, DesktopConfirmLimiter>(),
      platform: "win32",
      record: () => {
        throw new Error("log is full");
      },
    });
    const call = gate.check({ method: "type_text", arguments: NOTEPAD });
    const question = await parked(registry);
    question.answer([{ id: DESKTOP_CONFIRM_QUESTION_ID, selected: [DESKTOP_CONFIRM_APPROVE] }]);
    expect(await call).toEqual({ kind: "allow", approvedApp: "notepad.exe" });
  });

  it("没有接 record 时闸门照常工作（缺席是 no-op，不是降级成别的行）", async () => {
    const h = hostOf({ record: false });
    const call = h.gate.check({ method: "type_text", arguments: NOTEPAD });
    const question = await parked(h.registry);
    question.answer([{ id: DESKTOP_CONFIRM_QUESTION_ID, selected: [DESKTOP_CONFIRM_APPROVE] }]);
    expect(await call).toEqual({ kind: "allow", approvedApp: "notepad.exe" });
    expect(h.rows).toHaveLength(0);
  });

  it("★ 写出去的行走得进日志编解码：读回不是 torn tail，字节形状稳定", async () => {
    const h = hostOf();
    const call = h.gate.check({ method: "type_text", arguments: NOTEPAD });
    const question = await parked(h.registry);
    h.advance(700);
    question.answer([{ id: DESKTOP_CONFIRM_QUESTION_ID, selected: [DESKTOP_CONFIRM_APPROVE] }]);
    await call;
    // 这一行是「读侧认得它」的底线：codec 不认它 = 整个日志从这行起成 torn tail。
    const jsonl = h.rows.map((r) => serializeSessionEvent(r)).join("\n");
    expect(jsonl).toContain('"type":"desktop_confirm","id"');
    expect(jsonl).toContain('"reason":"sensitive_method"');
    expect(jsonl).toContain('"outcome":"approve","elapsed_ms":700');
    for (const line of jsonl.split("\n")) {
      const parsed = parseSessionEvent(line);
      expect(parsed.ok, line).toBe(true);
    }
    // 往返一次字段不丢（读回即审计读取路径）。
    const reread = parseSessionEvent(serializeSessionEvent(h.rows[0]!));
    expect(reread.ok).toBe(true);
    if (reread.ok) expect(reread.event).toEqual(h.rows[0]);
  });
});
describe("M2 确认传输 · 反疲劳限流跨代存活", () => {
  it("同一会话新建的闸门共用同一个限流器（冷却不会被 turn 边界清零）", async () => {
    const limiters = new Map<string, DesktopConfirmLimiter>();
    const first = hostOf({ sessionId: "sample-ws/s1", limiters });
    for (let i = 0; i < 3; i++) {
      const call = first.gate.check({ method: "type_text", arguments: NOTEPAD });
      const question = await parked(first.registry);
      question.answer([{ id: DESKTOP_CONFIRM_QUESTION_ID, selected: [DESKTOP_CONFIRM_DENY] }]);
      await call;
    }
    // 新一代闸门（= 下一个 turn 边界）必须继承那个冷却。
    const second = hostOf({ sessionId: "sample-ws/s1", limiters });
    const { code } = denied(await second.gate.check({ method: "type_text", arguments: NOTEPAD }));
    expect(code).toBe("desktop_confirm_cooldown");
    expect(second.registry.size()).toBe(0); // 冷却里连卡片都不该发出来
    // 另一个会话不受影响（限流按会话记账）。
    const other = hostOf({ sessionId: "sample-ws/s2", limiters });
    const otherCall = other.gate.check({ method: "type_text", arguments: NOTEPAD });
    const otherQuestion = await parked(other.registry);
    expect(otherQuestion.sessionId).toBe("sample-ws/s2");
    otherQuestion.answer([{ id: DESKTOP_CONFIRM_QUESTION_ID, selected: [DESKTOP_CONFIRM_APPROVE] }]);
    expect((await otherCall).kind).toBe("allow");
  });
});
