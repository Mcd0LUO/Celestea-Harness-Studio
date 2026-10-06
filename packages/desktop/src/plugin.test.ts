// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Context, TOOL_REGISTRY_SERVICE, mountPlugins, type Tool, type ToolInput, type ToolOutput, type ToolRegistry, type ToolSpec } from "@celestea/core";
import { DesktopHelperClient, desktopPlugin, type DesktopChildProcess, type DesktopSpawner, type HelperImage } from "./index.js";

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
function fakeHelper(opts: { answer: (name: string, args: Record<string, unknown>) => Answer; handshakeFails?: boolean; onSpawn?: (n: number) => void }): Fake {
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
    const answer = (line: string) => {
      const req = JSON.parse(line) as { id: number; method: string; params: { name?: string; arguments?: Record<string, unknown> }; meta?: Record<string, unknown> };
      metas.push(req.meta);
      let reply: unknown;
      if (req.method === "ping") {
        reply = opts.handshakeFails
          ? { id: req.id, ok: false, error: "unknown argument: --boom" }
          : { id: req.id, ok: true, result: { version: "0.1.0", platform: "win32", features: ["uia", "enum-windows"] } };
      } else {
        const name = req.params.name ?? "";
        const got = opts.answer(name, req.params.arguments ?? {});
        reply = got.ok
          ? { id: req.id, ok: true, result: { ok: true, name, value: got.value, images: got.images ?? [] } }
          : { id: req.id, ok: false, error: got.error };
      }
      emit("o:data", JSON.stringify(reply) + "\n");
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

function mountFake(fake: Fake, attachments: DesktopHelperClient extends never ? never : Parameters<typeof desktopPlugin>[0]["attachments"] = null) {
  const reg = fakeRegistry();
  const ctx = Context.root();
  ctx.provide(TOOL_REGISTRY_SERVICE, reg);
  mountPlugins(ctx, [desktopPlugin({ client: client(fake), attachments })]);
  return reg;
}

const JPEG = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8A9/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8BKQ//9k=";

describe("desktop plugin · mount-time registration", () => {
  it("registers exactly the four read-only tools, and no-ops without a registry", () => {
    const reg = mountFake(fakeHelper({ answer: () => ({ ok: true, value: [] }) }));
    expect(reg.schemas().map((s) => s.name).sort()).toEqual([
      "desktop_get_window", "desktop_get_window_state", "desktop_list_apps", "desktop_list_windows",
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
    // 顶层 attachments —— core/src/projection.ts:132 扫的正是这里。
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
