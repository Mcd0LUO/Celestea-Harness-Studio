/**
 * W833 (R3 B8 / W816 F5 + F7) — manual-turn start payload keys and the
 * no-argument cancel() target, on the REAL engine adapter.
 *
 * Source: /srv/ops/runtime/worker-exec/results/W827-R3修复计划-B-tools-workers-studio.md
 * §B8 W816 F5: a manual turn's status "start" payload must NOT carry a source
 * key; an autowake turn carries source:"autowake".
 * §B8 W816 F7: no-argument cancel() must cancel the most recently ACTIVE busy
 * session, not the first one in creation order.
 */

import { afterEach, describe, expect, it } from "vitest";

import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import { activate, asPayload, engineOf, makeEngineHarness, waitIdle } from "./test-util.js";

const harnesses: StudioHarness[] = [];

function make(options: Parameters<typeof makeEngineHarness>[0] = {}): StudioHarness {
  const h = makeEngineHarness(options);
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

interface Frame {
  event: string;
  payload: Record<string, unknown>;
}

describe("W833 B8/F5: start frame source key", () => {
  it("omits source on a manual turn", async () => {
    const h = make({ sessions: { s1: [] } });
    await activate(h, "sample-ws/s1");
    const sub = h.studio.services.bus.subscribe();
    await h.app.request("/api/turn", jsonRequest("POST", { input: "hi" }));
    const frames: Frame[] = [];
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const frame = await Promise.race([sub.next(), new Promise<null>((r) => setTimeout(() => r(null), 300))]);
      if (frame === null) break;
      frames.push({ event: frame.event, payload: asPayload(frame.envelope.payload) });
      if (frame.event === "turn_end") break;
    }
    sub.close();
    const start = frames.find((f) => f.event === "status" && f.payload["phase"] === "start");
    expect(start).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(start?.payload, "source")).toBe(false);
  });

  it("includes source=autowake on an autowake start frame", async () => {
    const h = make({ sessions: { s1: [] } });
    await activate(h, "sample-ws/s1");
    const sub = h.studio.services.bus.subscribe();
    const spawn = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W1", brief: "b", session: "sample-ws/s1" }));
    expect(spawn.status).toBe(200);
    const frames: Frame[] = [];
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const frame = await Promise.race([sub.next(), new Promise<null>((r) => setTimeout(() => r(null), 300))]);
      if (frame === null) continue;
      frames.push({ event: frame.event, payload: asPayload(frame.envelope.payload) });
      if (frames.some((f) => f.event === "status" && f.payload["source"] === "autowake" && f.payload["phase"] === "start")) break;
    }
    sub.close();
    expect(frames.some((f) => f.event === "status" && f.payload["source"] === "autowake" && f.payload["phase"] === "start")).toBe(true);
  });
});

describe("W833 B8/F7: no-arg cancel targets the most recently active session", () => {
  it("cancels the newest busy session, leaving the older one", async () => {
    // W9224 · 用 `hold` 把 s1 的忙状态**钉住**，而不是靠 deltaMs 赌时长。
    //
    // 为什么必须改：本用例要证的是「无参 cancel() 取消**最近活跃**的会话，
    // 且**不动**另一个仍然忙的会话」。原实现靠
    // `deltaMs: 3, chunkChars: 100`（16 帧）造一个「够长」的忙窗口 —— 但真实定时器
    // 粒度随平台变：Windows 实测 setTimeout(3) ≈ 14–17ms（窗口 ~280ms），
    // Linux 精确 3ms（窗口 **~48ms**）。用例在 activate(s2) 前固定睡 60ms，
    // 于是 Linux 上 s1 的轮次**已经结束**，line 92 的
    // `expect(isBusy(s1)).toBe(true)` 必然失败 —— ubuntu 两个 CI job 真实红过。
    // 本机（Windows）5/5 全绿正是因为粗粒度定时器把窗口撑大了。
    let releaseS1: (() => void) | undefined;
    const s1Held = new Promise<void>((resolve) => {
      releaseS1 = resolve;
    });
    const h = make({
      sessions: { s1: [], s2: [] },
      llm: { script: [{ text: "x".repeat(1600), hold: s1Held }, { text: "x".repeat(1600) }], deltaMs: 3, chunkChars: 100 },
    });
    await activate(h, "sample-ws/s1");
    const first = await h.app.request("/api/turn", jsonRequest("POST", { input: "one" }));
    expect(first.status).toBe(202);
    // 这里不再需要 sleep：s1 被 hold 钉住，忙状态是**确定的**。
    await activate(h, "sample-ws/s2");
    const second = await h.app.request("/api/turn", jsonRequest("POST", { input: "two" }));
    expect(second.status).toBe(202);

    const engine = engineOf(h);
    expect(engine.isBusy("sample-ws/s1")).toBe(true);
    expect(engine.isBusy("sample-ws/s2")).toBe(true);
    expect(engine.cancel()).toBe(true);

    const deadline = Date.now() + 5_000;
    while (engine.isBusy("sample-ws/s2") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(engine.isBusy("sample-ws/s2")).toBe(false);
    // s1 仍然被 hold 钉着 ⇒ 这条断言现在是**确定的**，与平台定时器粒度无关。
    expect(engine.isBusy("sample-ws/s1")).toBe(true);

    engine.cancel("sample-ws/s1");
    releaseS1?.();
    await waitIdle(h);
  }, 30_000);
});
