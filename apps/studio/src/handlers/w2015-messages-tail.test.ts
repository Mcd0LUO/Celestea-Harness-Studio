/**
 * W2015 · `GET /api/sessions/{id}/messages` 的 `?tail=N` 裁剪 —— 后端侧门禁。
 *
 * 缺陷（真机实测，见 results/W2015-messages-payload.md）：一个 1047 条消息的真实会话
 * 整份响应 1 421 547 字节，而前端只渲染最近 200 条（ui/restore.ts 的 MAX_RESTORE）——
 * 前 847 条（约 1.1MB）是纯浪费：既占带宽，也在打开会话的关键路径上多一次 1.4MB 的
 * JSON 解析与对象分配。
 *
 * 本文件锁三件事：
 *   ① 上限：构造的大会话上，`?tail=201` 的响应字节数远小于全量，且**等于**最后 201 条
 *      单独序列化的字节数（期望值从真实构造派生，不写死常数）；
 *   ② 不丢数据：不带 `tail` 仍回**全量**，逐条与构造的输入相同 —— 被裁的部分始终可取；
 *   ③ 边界：`tail=0` 是「零条」而非「默认」，非法值（负数/小数/空/非数字）回落默认。
 *
 * 变异负控制（本文件的断言确实有牙，报告 §变异负控制 贴红→绿原文）：
 *   M1 把 `window()` 换成恒等（回退成整份返回）⇒ ① 的字节断言必红；
 *   M2 把窗口算成 `slice(0, tail)`（裁错端）⇒ ② 的「尾部一致」断言必红；
 *   M3 把「无 tail = 全量」改成「无 tail = 默认窗口」⇒ ② 的全量断言必红。
 */
import { describe, expect, it } from "vitest";
import { getJson, makeHarness } from "../harness.test-util.js";

const S1 = "sample-ws%2Fs1";

/** 构造一条足够大的工具结果 —— 真实会话里 68% 的字节就是这种行。 */
function toolResult(i: number, pad: number): string {
  return JSON.stringify({
    type: "tool_result",
    id: `call-${i}`,
    value: { ok: true, stdout: `line ${i} `.repeat(pad) },
    error: null,
  });
}

/**
 * 一个「长会话」日志：`turns` 轮，每轮 1 用户 + 1 助手 + 1 工具调用 + 1 工具结果。
 * 每条工具结果的正文长度由 `pad` 控制 —— 于是「大」这件事是构造出来的，
 * 不是从别处抄来的数字。
 */
function bigLog(turns: number, pad = 400): string {
  const rows: string[] = [];
  for (let i = 0; i < turns; i += 1) {
    rows.push(JSON.stringify({ type: "turn_start", id: `turn-${i}` }));
    rows.push(JSON.stringify({ type: "user_message", text: `问题 ${i}` }));
    rows.push(JSON.stringify({ type: "assistant_message", text: `回答 ${i}` }));
    rows.push(JSON.stringify({ type: "tool_call", id: `call-${i}`, name: "bash", args: { cmd: `echo ${i}` } }));
    rows.push(toolResult(i, pad));
    rows.push(JSON.stringify({ type: "turn_end", id: `turn-${i}` }));
  }
  return rows.join("\n") + "\n";
}

/** 一次响应体的**线字节数**：与前端真正下载到的是同一个量。 */
function wireBytes(body: unknown): number {
  return Buffer.byteLength(JSON.stringify(body), "utf8");
}

type Msg = Record<string, unknown>;
const msgsOf = (body: Record<string, unknown>): Msg[] => (body["messages"] ?? []) as Msg[];

describe("W2015 · messages 的 ?tail=N 裁剪", () => {
  /** 构造出的会话：500 轮（与真实会话 1047 条消息同量级）。 */
  const TURNS = 500;
  /**
   * 每轮投影出 4 条：user_message / assistant_message / tool_call / tool_result。
   * （turn_start 与 turn_end 是结构标记，投影为 null —— 见 packages/session/src/messages.ts。）
   * 断言**不写死这个数**：用例自己先量一次全量，再拿它当基准（见 ② 的 all.length）。
   */
  const PER_TURN = 4;
  const h = makeHarness({ session: { name: "s1", log: bigLog(TURNS) } });

  it("① 上限：?tail=201 远小于全量，且等于「最后 201 条」的字节数", async () => {
    const full = await getJson(h.app, `/api/sessions/${S1}/messages`);
    const cut = await getJson(h.app, `/api/sessions/${S1}/messages?tail=201`);
    expect(full.status).toBe(200);
    expect(cut.status).toBe(200);

    const all = msgsOf(full.body);
    const tail = msgsOf(cut.body);
    // 期望值从**真实构造**派生：全量自己就有 1000 条。
    expect(all.length, "构造出的会话必须是长会话").toBeGreaterThanOrEqual(1000);
    expect(tail.length).toBe(201);

    const fullBytes = wireBytes(full.body);
    const cutBytes = wireBytes(cut.body);
    // ①-a 确实小了一个量级（上限判据）。
    expect(cutBytes, `tail 响应 ${cutBytes}B 应远小于全量 ${fullBytes}B`).toBeLessThan(fullBytes / 4);
    // ①-b 而且**不多不少**就是那 201 条 —— 证明省下的是「前端不用的部分」，
    // 不是靠牺牲内容换来的。
    expect(cutBytes).toBe(wireBytes({ ok: true, session: "sample-ws/s1", messages: all.slice(all.length - 201) }));
  });

  it("② 不丢数据：不带 tail 仍是全量，且尾部与裁剪路径逐条相同", async () => {
    const full = await getJson(h.app, `/api/sessions/${S1}/messages`);
    const cut = await getJson(h.app, `/api/sessions/${S1}/messages?tail=201`);
    const all = msgsOf(full.body);
    const tail = msgsOf(cut.body);

    expect(all.length, "全量必须是构造出的全部消息").toBe(TURNS * PER_TURN);
    // 尾部一致 = 裁剪取的是**最近**的那些，不是随便一段。
    expect(tail).toEqual(all.slice(all.length - 201));
    // 头部仍在全量里（被裁掉的部分一条没丢）。
    expect(all[0]).toEqual({ role: "user", content: "问题 0" });
    // 末条 = 最后一轮的工具结果（每轮投影顺序：user → assistant → call → result）。
    expect(all[all.length - 1]).toMatchObject({ role: "tool", kind: "result", tool_call_id: `call-${TURNS - 1}` });
    // 而且被裁掉的那 799 条确实**不在**裁剪响应里（否则「省字节」是假象）。
    expect(tail.some((m) => m["content"] === "问题 0"), "最老的一条不应出现在 tail 里").toBe(false);
  });

  it("③ 边界：tail=0 是零条；非法值回落全量", async () => {
    const zero = await getJson(h.app, `/api/sessions/${S1}/messages?tail=0`);
    expect(zero.status).toBe(200);
    expect(msgsOf(zero.body), "tail=0 = 零条，不是默认").toEqual([]);

    const full = await getJson(h.app, `/api/sessions/${S1}/messages`);
    const total = msgsOf(full.body).length;
    for (const bad of ["-5", "1.5", "", "abc", "1e3", "  "]) {
      const res = await getJson(h.app, `/api/sessions/${S1}/messages?tail=${encodeURIComponent(bad)}`);
      expect(res.status, `tail=${JSON.stringify(bad)}`).toBe(200);
      expect(msgsOf(res.body).length, `tail=${JSON.stringify(bad)} 应回落全量`).toBe(total);
    }
  });

  it("④ tail >= 总数时不裁剪（窗口比列表大 = 原样）", async () => {
    const full = await getJson(h.app, `/api/sessions/${S1}/messages`);
    const big = await getJson(h.app, `/api/sessions/${S1}/messages?tail=${msgsOf(full.body).length + 50}`);
    expect(msgsOf(big.body)).toEqual(msgsOf(full.body));
  });
});
