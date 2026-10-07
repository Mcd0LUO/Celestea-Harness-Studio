// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Context, TOOL_REGISTRY_SERVICE, mountPlugins, type Tool, type ToolInput, type ToolOutput, type ToolRegistry, type ToolSpec } from "@celestea/core";
import { DesktopHelperClient, desktopPlugin, denyAllGate, type DesktopChildProcess, type DesktopSpawner, type HelperImage } from "./index.js";
import type { DesktopGate, DesktopGateCall } from "./gate.js";
import type { DesktopToolDeps } from "./tool.js";

/** The deps subset the tests drive directly (attachments + gate). */
type DesktopGateDeps = Pick<DesktopToolDeps, "attachments">;

/**
 * M1 链路的**行为**门禁（契约形状在 tests/desktop-tool-contract.test.ts）。
 *
 * 这里证三件只有真跑才看得见的事：
 *   1. 插件在 mount 时把四个工具注册进宿主注册表（无注册表时整件事不发生）；
 *   2. 一次调用真走 NDJSON `{id,method,params}`、按 id 配对 `{id,ok,result}`；
 *   3. helper 的 images 真落到工具结果**顶层** attachments（core 的投影入口），
 *      无 store 时诚实降级且绝不把 base64 塞回文本。
 *
 * 唯一的外部边界是子进程，所以 mock 它（仓内纪律：只 mock 外部边界）。响应形状逐字取自
 * packages/desktop/helper/src：protocol.rs 的 official_ok + call_result(main.rs 的 call 分支)。
 */

type Answer = { ok: true; value: unknown; images?: HelperImage[] } | { ok: false; error: string };
interface Fake { spawn: DesktopSpawner; writes: string[]; metas: Array<Record<string, unknown> | undefined>; spawnCount: () => number; }

/**
 * 一个逐条应答的假 helper。它**按真实协议**区分 ping / call，并原样回 official_ok 信封——
 * 一个「什么都答成功」的 stub 会把「根本没接通」伪装成「接通了」。
 */
function fakeHelper(opts: {
  answer: (name: string, args: Record<string, unknown>) => Answer;
  handshakeFails?: boolean;
  onSpawn?: (n: number) => void;
  /** 握手回答前要等的门：制造「spawned but not handshaked」窗口。 */
  beforePing?: () => Promise<void> | void;
  /** 业务回答改成按**原始字节**投递（测 UTF-8 跨块），带一个切分点。 */
  splitReply?: { bytes: Buffer; splitAt: number; rawRequestId: number };
}): Fake {
  const writes: string[] = [];
  const metas: Array<Record<string, unknown> | undefined> = [];
  let spawns = 0;
  const spawn: DesktopSpawner = () => {
    spawns += 1;
    opts.onSpawn?.(spawns);
    const bus = new Map<string, Array<(arg: unknown) => void>>();
    const on = (key: string, fn: (arg: unknown) => void) => {
      bus.set(key, [...(bus.get(key) ?? []), fn]);
    };
    let buffer = "";
    const child: DesktopChildProcess = {
      stdin: {
        write: (chunk: string) => {
          writes.push(String(chunk));
          buffer += chunk;
          let nl = buffer.indexOf("\n");
          while (nl >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line !== "") answer(line);
            nl = buffer.indexOf("\n");
          }
          return true;
        },
      },
      stdout: { on: (event, fn) => (on(`o:${event}`, fn as (a: unknown) => void), true) },
      stderr: { on: (event, fn) => (on(`e:${event}`, fn as (a: unknown) => void), true) },
      on: (event, fn) => (on(event, fn as (a: unknown) => void), true),
      kill: () => true,
    };
    const emit = (key: string, arg: unknown) => { for (const fn of bus.get(key) ?? []) fn(arg); };
    const send = (reply: unknown) => { emit("o:data", JSON.stringify(reply) + "\n"); };
    const answer = (line: string) => {
      const req = JSON.parse(line) as { id: number; method: string; params: { name?: string; arguments?: Record<string, unknown> }; meta?: Record<string, unknown> };
      metas.push(req.meta);
      if (req.method === "ping") {
        const reply = opts.handshakeFails
          ? { id: req.id, ok: false, error: "unknown argument: --boom" }
          : { id: req.id, ok: true, result: { version: "0.1.0", platform: "win32", features: ["uia", "enum-windows"] } };
        // 握手门：先返回一个 pending 的 Promise，让「spawned but not handshaked」
        // 窗口真实存在（响应推迟到放行之后），窗口内的并发调用才是被测对象。
        const gate = opts.beforePing?.();
        if (gate === undefined) { send(reply); return; }
        void Promise.resolve(gate).then(() => send(reply));
        return;
      }
      if (opts.splitReply !== undefined && req.id === opts.splitReply.rawRequestId) {
        // 按原始字节分两段投递，切点落在某个多字节字符**中间**。
        const { bytes, splitAt } = opts.splitReply;
        emit("o:data", bytes.subarray(0, splitAt));
        emit("o:data", bytes.subarray(splitAt));
        return;
      }
      const name = req.params.name ?? "";
      const got = opts.answer(name, req.params.arguments ?? {});
      send(
        got.ok
          ? { id: req.id, ok: true, result: { ok: true, name, value: got.value, images: got.images ?? [] } }
          : { id: req.id, ok: false, error: got.error },
      );
    };
    return child;
  };
  return { spawn, writes, metas, spawnCount: () => spawns };
}

/** 最小注册表：记下注册了什么，并按名字分发（返回 ToolOutput，不抛）。 */
function fakeRegistry(): ToolRegistry {
  const tools = new Map<string, Tool>();
  return {
    register: (tool) => void tools.set(tool.spec().name, tool),
    addGuard: () => undefined,
    get: (name) => tools.get(name),
    schemas: (): ToolSpec[] => [...tools.values()].map((t) => t.spec()),
    dispatch: async (input: ToolInput): Promise<ToolOutput> => {
      const tool = tools.get(input.name);
      if (tool === undefined) return { call_id: input.call_id, value: null, render: null, error: "unknown tool", decision: null };
      try {
        return { call_id: input.call_id, value: await tool.execute(input.args), render: null, error: null, decision: null };
      } catch (e) {
        return { call_id: input.call_id, value: null, render: null, error: e instanceof Error ? e.message : String(e), decision: null };
      }
    },
  };
}

function client(fake: Fake, platform = "win32"): DesktopHelperClient {
  return new DesktopHelperClient({ helperPath: "C:/fake/celestea-desktop-helper.exe", platform, spawn: fake.spawn, stderr: { write: () => true }, handshakeTimeoutMs: 500, timeoutMs: 500 });
}

function mountFake(
  fake: Fake,
  attachments: DesktopGateDeps["attachments"] = null,
  gate?: DesktopGate,
) {
  const reg = fakeRegistry();
  const ctx = Context.root();
  ctx.provide(TOOL_REGISTRY_SERVICE, reg);
  mountPlugins(ctx, [desktopPlugin({ client: client(fake), attachments, ...(gate === undefined ? {} : { gate }) })]);
  return reg;
}

const JPEG = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8A9/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8BKQ//9k=";

describe("desktop plugin · mount-time registration", () => {
  it("registers exactly the thirteen window2 tools, and no-ops without a registry", () => {
    const reg = mountFake(fakeHelper({ answer: () => ({ ok: true, value: [] }) }));
    // M1 时这里钉的是四个只读；M2 起是十三个（helper 的 window2 核心面，恰好 13 个）。
    // 写 9 也在注册表里 —— 它们由**闸门**在调用时放行，不是由注册表决定有没有。
    expect(reg.schemas().map((s) => s.name).sort()).toEqual([
      "desktop_activate_window", "desktop_click", "desktop_drag", "desktop_get_window",
      "desktop_get_window_state", "desktop_launch_app", "desktop_list_apps", "desktop_list_windows",
      "desktop_press_key", "desktop_scroll", "desktop_secondary_action", "desktop_set_value",
      "desktop_type_text",
    ]);
    // No ToolRegistry = the tools plugin has not mounted: a no-op, never a throw.
    const bare = Context.root();
    const fake = fakeHelper({ answer: () => ({ ok: true, value: [] }) });
    expect(() => mountPlugins(bare, [desktopPlugin({ client: client(fake), attachments: null })])).not.toThrow();
    expect(fake.spawnCount()).toBe(0);
  });
});

describe("desktop client · one NDJSON round trip, id-paired", () => {
  it("handshakes with ping, then routes the tool over method:call", async () => {
    const seen: string[] = [];
    const fake = fakeHelper({
      answer: (name) => {
        seen.push(name);
        return name === "list_windows"
          ? { ok: true, value: [{ app: "notepad.exe", id: 1234, title: "notes" }] }
          : { ok: true, value: [] };
      },
    });
    const reg = mountFake(fake);
    const out = await reg.dispatch({ call_id: "c1", name: "desktop_list_windows", args: {} });
    expect(out.error).toBeNull();
    expect(out.value).toEqual({ ok: true, count: 1, windows: [{ app: "notepad.exe", id: 1234, title: "notes" }] });
    const ping = JSON.parse(fake.writes[0] ?? "{}") as { method?: string };
    const call = JSON.parse(fake.writes[1] ?? "{}") as { method?: string; params?: { name?: string }; id?: number };
    expect(ping.method).toBe("ping");
    // ALWAYS "call": only that path has helper split the screenshots out to images.
    expect(call.method).toBe("call");
    expect(call.params?.name).toBe("list_windows");
    expect(typeof call.id).toBe("number");
    expect(seen).toEqual(["list_windows"]);
  });
});

describe("desktop client · helper images land on the value TOP level", () => {
  it("stores them and returns ImageRefs where core's projection looks", async () => {
    const fake = fakeHelper({
      answer: (name) =>
        name === "get_window_state"
          ? { ok: true, value: { window: { app: "notepad.exe", id: 7 }, screenshots: [{ id: "s0" }] }, images: [{ mimeType: "image/jpeg", data: JPEG, name: "s0" }] }
          : { ok: true, value: [] },
    });
    const seenBytes: number[] = [];
    const reg = mountFake(fake, {
      put: async (input) => {
        seenBytes.push(input.bytes.length);
        return { attachment_id: "a".repeat(64), media_type: "image/jpeg", width: 2, height: 2 };
      },
    });
    const out = await reg.dispatch({ call_id: "c2", name: "desktop_get_window_state", args: { window: { app: "notepad.exe", id: 7 } } });
    expect(out.error).toBeNull();
    const value = out.value as { ok: boolean; attachments: unknown[]; window: unknown };
    expect(value.ok).toBe(true);
    // 顶层 attachments —— core/src/projection.ts 扫的正是这里。
    expect(value.attachments).toEqual([{ attachment_id: "a".repeat(64), media_type: "image/jpeg", width: 2, height: 2 }]);
    expect(value.window).toEqual({ app: "notepad.exe", id: 7 });
    expect(seenBytes[0]).toBeGreaterThan(0);
  });

  it("degrades honestly with no store, and never leaks base64 into the text", async () => {
    const fake = fakeHelper({
      answer: (name) =>
        name === "get_window_state"
          ? { ok: true, value: { window: { app: "notepad.exe", id: 7 } }, images: [{ mimeType: "image/jpeg", data: JPEG, name: "s0" }] }
          : { ok: true, value: [] },
    });
    const reg = mountFake(fake);
    const out = await reg.dispatch({ call_id: "c3", name: "desktop_get_window_state", args: { window: { app: "notepad.exe", id: 7 } } });
    const value = out.value as { attachments: unknown[]; notes: string[]; window: unknown };
    expect(value.attachments).toEqual([]);
    expect(value.notes[0]).toContain("no attachment store");
    // 元数据仍然可用，且没有 base64 混进模型可见的结果。
    expect(value.window).toEqual({ app: "notepad.exe", id: 7 });
    expect(JSON.stringify(value)).not.toContain(JPEG.slice(0, 40));
  });
});

describe("desktop client · the pre-granted app is the read-only whitelist and nothing else", () => {
  it("passes the app for a read-only call, and refuses it for any other method", async () => {
    const fake = fakeHelper({ answer: () => ({ ok: true, value: { app: "notepad.exe", id: 7 } }) });
    const reg = mountFake(fake);
    await reg.dispatch({ call_id: "c4", name: "desktop_get_window", args: { id: 7, app: "notepad.exe" } });
    expect(fake.metas[1]?.["x-oai-cua-approved-app"]).toBe("notepad.exe");
    // fail-closed: M2 的写方法永远不得复用这条预置。
    const c = client(fake);
    await expect(c.callTool("click", { window: { app: "a", id: 1 } }, "notepad.exe")).rejects.toThrow(/not read-only/);
  });
});

describe("desktop client · lazy start, one restart, then a structured error", () => {
  it("spawns nothing until the first call and never loops on a failed handshake", async () => {
    const fake = fakeHelper({ answer: () => ({ ok: true, value: null }), handshakeFails: true });
    const c = client(fake);
    expect(fake.spawnCount()).toBe(0);
    await expect(c.callTool("list_windows", {})).rejects.toThrow(/handshake/);
    // one attempt plus at most ONE restart — never an unbounded retry loop
    expect(fake.spawnCount()).toBe(2);
    expect(c.degraded).toContain("handshake_failed");
  });

  it("never spawns on a non-win32 platform, whatever is on disk", async () => {
    const fake = fakeHelper({ answer: () => ({ ok: true, value: [] }) });
    const c = client(fake, "darwin");
    await expect(c.callTool("list_windows", {})).rejects.toThrow(/win32/);
    expect(fake.spawnCount()).toBe(0);
  });
});

describe("desktop client · concurrency during the handshake window", () => {
  it("makes every concurrent caller await ONE starting promise, and writes no business request before the handshake", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: string[] = [];
    const fake = fakeHelper({
      answer: (name) => {
        seen.push(name);
        return name === "list_windows" ? { ok: true, value: [{ app: "a.exe", id: 1 }] } : { ok: true, value: [] };
      },
      beforePing: () => gate,
    });
    const c = client(fake);
    // 三个并发调用：两个业务 + 一个握手。握手单独持有（不塞进 Promise.all 的数组），
    // 这样它的返回类型不会被数组的元素类型并成 `HelperCallResult`。
    const handshake = c.handshake();
    const calls = [c.callTool("list_windows", {}), c.callTool("list_apps", {})];
    // 窗口期内：只 spawn 了一次（并发调用共用同一次启动），且除 ping 外**零**业务写入 ——
    // 这正是旧实现（先判 child）会把业务请求写进未握手 helper 的地方。
    expect(fake.spawnCount()).toBe(1);
    expect(fake.writes.map((line) => JSON.parse(line).method)).toEqual(["ping"]);
    release();
    const [first, second] = await Promise.all(calls);
    const hs = await handshake;
    expect(seen).toEqual(["list_windows", "list_apps"]);
    expect((first as { value: unknown }).value).toEqual([{ app: "a.exe", id: 1 }]);
    expect((second as { value: unknown }).value).toEqual([]);
    // 并发的 handshake() 拿到的是真信封，而不是一个伪 handshake_failed。
    expect(hs.platform).toBe("win32");
    expect(hs.version).toBe("0.1.0");
    // 单例：三个并发调用共用一个 helper 进程。
    expect(fake.spawnCount()).toBe(1);
  });
});

describe("desktop client · a multi-byte character split across stdio chunks", () => {
  it("keeps a Chinese window title intact when the split lands mid-character", async () => {
    const TITLE = "万界放映厅：跨时代聊天室 — 正在输入… 🎬";
    // 请求 id 1 = 握手、2 = 第一个业务调用（client 从 1 开始发）。
    const reply = Buffer.from(JSON.stringify({ id: 2, ok: true, result: { ok: true, name: "list_windows", value: [{ app: "notepad.exe", id: 5, title: TITLE }], images: [] } }) + "\n", "utf8");
    // 切点落在 TITLE 第一个多字节字符（「万」= E4 B8 87）的第 1 个字节之后。
    const cut = reply.indexOf(Buffer.from(TITLE.slice(0, 1), "utf8").subarray(0, 1)) + 1;
    expect(cut).toBeGreaterThan(0);
    const fake = fakeHelper({
      answer: () => ({ ok: true, value: [] }),
      splitReply: { bytes: reply, splitAt: cut, rawRequestId: 2 },
    });
    const c = client(fake);
    const res = (await c.callTool("list_windows", {})) as { value: Array<{ title?: string }> };
    expect(res.value[0]?.title).toBe(TITLE);
    // 逐块独立 toString 会在这里产出 U+FFFD；StringDecoder 不会。
    expect(String(res.value[0]?.title)).not.toContain("\uFFFD");
  });
});

describe("desktop client · a helper error is a RESULT the model can read", () => {
  it("surfaces the helper's own sentence as a structured failure envelope", async () => {
    const reg = mountFake(fakeHelper({ answer: () => ({ ok: false, error: "Windows desktop is locked (input desktop is Winlogon); unlock before using computer-use" }) }));
    const out = await reg.dispatch({ call_id: "c5", name: "desktop_list_windows", args: {} });
    expect(out.error).toBeNull(); // not an exception: the turn survives
    expect(out.value).toEqual({
      ok: false,
      step: "list_windows",
      code: "tool_error",
      error: "Windows desktop is locked (input desktop is Winlogon); unlock before using computer-use",
      detail: { method: "list_windows" },
    });
  });
});

describe("desktop tools · the M2 write nine and the gate", () => {
  const WRITE = [
    ["desktop_click", "click"],
    ["desktop_press_key", "press_key"],
    ["desktop_type_text", "type_text"],
    ["desktop_scroll", "scroll"],
    ["desktop_set_value", "set_value"],
    ["desktop_drag", "drag"],
    ["desktop_secondary_action", "perform_secondary_action"],
    ["desktop_activate_window", "activate_window"],
    ["desktop_launch_app", "launch_app"],
  ] as const;

  it("registers all thirteen and refuses every write tool under denyAllGate, without touching the helper", async () => {
    const fake = fakeHelper({ answer: () => ({ ok: true, value: null }) });
    const reg = mountFake(fake, null, denyAllGate());
    expect(reg.schemas()).toHaveLength(13);
    for (const [tool] of WRITE) {
      const out = await reg.dispatch({ call_id: `c-${tool}`, name: tool, args: { window: { app: "notepad.exe", id: 1 } } });
      // 结果不是异常：turn 存活，模型看到能据此改计划的一句话。
      expect(out.error, tool).toBeNull();
      expect(out.value, tool).toEqual({
        ok: false,
        code: "desktop_gate_unconfigured",
        error: "desktop gate 尚未启用（M2 集成中）",
        source: "desktop_gate",
        step: expect.any(String),
      });
    }
    // 闸门拒的东西一次都不该发往 helper —— 连进程都不该起。
    expect(fake.spawnCount()).toBe(0);
  });

  it("sends a write method with the approvedApp the GATE returned, and nothing else", async () => {
    const fake = fakeHelper({ answer: () => ({ ok: true, value: null }) });
    const seen: DesktopGateCall[] = [];
    const reg = mountFake(fake, null, {
      check: (call) => {
        seen.push(call);
        return Promise.resolve({ kind: "allow", approvedApp: "notepad.exe" });
      },
    });
    const out = await reg.dispatch({ call_id: "c1", name: "desktop_click", args: { window: { app: "notepad.exe", id: 1 }, x: 10, y: 20 } });
    expect(out.error).toBeNull();
    expect(out.value).toMatchObject({ ok: true, method: "click" });
    // 闸门拿到的是原样的方法名与参数（目标应用由它自己解析）。
    expect(seen).toEqual([{ method: "click", arguments: { window: { app: "notepad.exe", id: 1 }, x: 10, y: 20 } }]);
    // 批准只经闸门这一条路进 helper 的 meta。
    const call = JSON.parse(fake.writes[1] ?? "{}") as { method?: string; params?: { name?: string }; meta?: Record<string, unknown> };
    expect(call.method).toBe("call");
    expect(call.params?.name).toBe("click");
    expect(call.meta?.["x-oai-cua-approved-app"]).toBe("notepad.exe");
  });

  it("passes a helper lease_violation through as a result, leaving the turn alive", async () => {
    // helper 的租约冲突原句（规划 §5：检测到外部输入 → 中止剩余动作）。它必须原样
    // 到达模型 —— 翻译它等于丢掉「用户抢了鼠标」这个事实。
    const message = "lease_violation: external input detected during the action sequence; stopped after 2 of 5 steps";
    const fake = fakeHelper({ answer: (name) => (name === "type_text" ? { ok: false, error: message } : { ok: true, value: null }) });
    const reg = mountFake(fake, null, { check: () => Promise.resolve({ kind: "allow", approvedApp: "notepad.exe" }) });
    const out = await reg.dispatch({ call_id: "c1", name: "desktop_type_text", args: { window: { app: "notepad.exe", id: 1 }, text: "hi" } });
    // ToolOutput.error 是 null（工具没抛），原句在 value 里。
    expect(out.error).toBeNull();
    expect(out.value).toEqual({ ok: false, step: "type_text", code: "tool_error", error: message, detail: { method: "type_text" } });
  });
});
