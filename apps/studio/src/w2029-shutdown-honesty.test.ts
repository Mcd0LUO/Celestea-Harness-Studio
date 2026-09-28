/**
 * W2029 · 优雅退出路径的两个「日志说谎」缺陷 —— 有牙的门禁。
 *
 * 缺陷 A（假成功）：`within()` 在超时时**静默 resolve**（W2014 刻意的语义），
 *   但 `stop()` 丢掉了这个结果 ⇒ 超时也照打「audit flushed」。运维从日志里
 *   无法区分「审计真的落盘」与「到点放弃了」。这与 LTS ops「审计双通道」的
 *   纪律（写失败如实报，不静默）直接冲突。
 * 缺陷 B（文案与行为不符）：二次信号只 `return`，却打「exiting now (in-flight
 *   work is dropped)」—— 既不退出、也不丢弃，第一次 drain 仍在继续。
 *
 * ## 为什么这些断言是**确定性**的，不是靠 sleep 赌
 *   · 缺陷 A：把 `GrantsAuditWriter.prototype.flush` 换成**永不 resolve** 的
 *     Promise ⇒ 截止时间必然先到（不依赖任何真实耗时）；
 *   · stopTraffic：先确认 SSE 响应头**已到达**（连接确凿处于打开态），
 *     `server.close()` 在 `closeAllConnections()` 之前**不可能** resolve ⇒
 *     必然走超时分支；
 *   · 二次信号：第一次 `stop()` 在第一个 `await` 处让出后立刻发第二次，
 *     `stopping` 必为 true。
 *
 * ## 捕获日志
 * `log()` 走 `console.log`（server.ts:146）。这里临时替换 `console.log` 并在
 * finally 还原；`onListening` 在启动横幅**之后**触发，所以它那一刻的行号就是
 * 「启动噪声 / 退出日志」的精确分界，不需要靠前缀猜。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeRuntimeAdapter } from "./fake-runtime-adapter.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import { startStudioServer, type StudioServerHandle } from "./server.js";
import { GrantsAuditWriter } from "./store/grants-audit.js";

const PREFIX = "[celestea-studio-ts] ";
/** 正常路径的**逐字**基线（改动前后必须完全相同，§2④）。 */
const NORMAL_SEQUENCE = [
  "SIGTERM received — draining (grace 2000ms)",
  "traffic stopped (listener closed, leftover sockets cut)",
  "audit flushed",
  "engine stopped (workers settled, session logs closed) — loop may drain",
];
/**
 * 超时用例的小预算：`within()` 的超时由**注入的永不 resolve 的 work** 保证，
 * 与预算大小无关 —— 用小值只是不让门禁白等 7 秒。
 * 正常路径（①/⑤）**必须**用默认 2000/5000，因为 §2④ 钉的是默认口径的逐字基线。
 */
const FAST_DRAIN = "120";
const FAST_TEARDOWN = "120";
/** 超时告警的稳定子串（文案可读性可调，但「不是成功文案」必须钉死）。 */
const AUDIT_TIMEOUT = `audit flush TIMED OUT after ${FAST_DRAIN}ms`;
const ENGINE_TIMEOUT = `engine teardown TIMED OUT after ${FAST_TEARDOWN}ms`;
/** 缺陷 B 修复后的措辞：必须说「还在 drain」，不得声称「立刻退出」。 */
const AGAIN_LINE = "SIGTERM again — already draining";
/** 修复前的谎言（变异负控制③把它放回来，断言必须变红）。 */
const OLD_LIE = "exiting now (in-flight work is dropped)";

const roots: string[] = [];
const disposers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  // 收尾在**静音**下进行：用例已经 stop 过的句柄再 stop 一次只会打一行
  // 「again」，不该跑到真实 stdout 上去干扰读日志的人。
  const original = console.log;
  console.log = (): void => {};
  try {
    for (const dispose of disposers.splice(0)) await dispose();
  } finally {
    console.log = original;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 一次性数据根：与 sse-teardown.test.ts 的 throwawayEnv 同形。 */
function throwawayEnv(): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "w2029-"));
  roots.push(root);
  writeFileSync(join(root, "workspaces.json"), JSON.stringify({ workspaces: [], active_session: null }));
  return {
    root,
    env: {
      CELESTEA_HOME: root,
      CELESTEA_WORKSPACES_FILE: join(root, "workspaces.json"),
      CELESTEA_PROVIDERS_FILE: join(root, "providers.json"),
      CELESTEA_PROMPTS_FILE: join(root, "prompts.json"),
      STUDIO_STATIC_ROOT: join(root, "dist"),
    },
  };
}

interface Captured {
  lines: string[];
  stop(): string[];
}

/** 临时接管 `console.log`；调用方必须在 finally 里 `stop()`。 */
function captureConsoleLog(): Captured {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  return {
    lines,
    stop: (): string[] => {
      console.log = original;
      return lines;
    },
  };
}

/** 从 `from` 行起，只保留本服务器打的日志，并剥掉前缀。 */
function teardownLines(lines: string[], from: number): string[] {
  return lines
    .slice(from)
    .filter((line) => line.startsWith(PREFIX))
    .map((line) => line.slice(PREFIX.length));
}

interface Started {
  handle: StudioServerHandle;
  /** 退出日志在捕获数组里的起点（启动横幅之后）。 */
  boundary: () => number;
}

/** 起一个真实服务器；`onListening` 在横幅之后触发，正好是分界点。 */
function start(env: NodeJS.ProcessEnv, runtime?: RuntimeAdapter): Started {
  let boundary = 0;
  const handle = startStudioServer({
    port: 0,
    hostname: "127.0.0.1",
    log: true,
    cwd: env["CELESTEA_HOME"] ?? process.cwd(),
    env,
    runtime: runtime ?? createFakeRuntimeAdapter({ profile: { model: "test-model" } }),
    onListening: () => {
      boundary = capturedLines().length;
    },
  });
  disposers.push(() => handle.stop("SIGTERM"));
  return { handle, boundary: () => boundary };
}

/** 当前捕获缓冲（`start` 的 onListening 需要读它）。 */
let activeCapture: Captured | null = null;
function capturedLines(): string[] {
  return activeCapture?.lines ?? [];
}

/**
 * 把 audit.flush 换成**永不 resolve** 的 Promise —— 确定性超时的注入 seam。
 * 用原型级替换是因为 `startStudioServer` 内部自己组装 services，句柄不外露。
 */
function stubAuditFlush(impl: () => Promise<void>): () => void {
  const proto = GrantsAuditWriter.prototype as unknown as { flush: () => Promise<void> };
  const original = proto.flush;
  proto.flush = impl;
  return () => {
    proto.flush = original;
  };
}

/** 给假适配器加一个**永不 resolve** 的 shutdown（确定性 engine 超时）。 */
function withHangingShutdown(base: RuntimeAdapter): RuntimeAdapter {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "shutdown") return (): Promise<void> => new Promise<void>(() => {});
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

/** 打开一个真实的 SSE 连接，等**响应头真的到达**（连接确凿处于打开态）。 */
async function openSse(port: number): Promise<{ destroy: () => void; closed: () => boolean; head: () => string }> {
  const socket = connect(port, "127.0.0.1");
  let text = "";
  let sawHead: (() => void) | null = null;
  const head = new Promise<void>((resolve) => {
    sawHead = resolve;
  });
  socket.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
    if (text.includes("\r\n\r\n")) sawHead?.();
  });
  let closed = false;
  socket.on("close", () => {
    closed = true;
    sawHead?.();
  });
  socket.on("error", () => {
    closed = true;
    sawHead?.();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  socket.write("GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n");
  await Promise.race([head, new Promise<void>((r) => setTimeout(r, 5_000))]);
  // `void`：disposer 的返回值是 net.Socket，不是收尾动作的 Promise。
  disposers.push(() => void socket.destroy());
  return { destroy: () => socket.destroy(), closed: () => closed, head: () => text.split("\r\n\r\n")[0] ?? "" };
}

describe("W2029 · 退出路径的日志必须与行为一致", () => {
  it("① 正常路径：日志序列与基线**逐字相同**（§2④ 不许动）", async () => {
    const { env } = throwawayEnv();
    const capture = captureConsoleLog();
    activeCapture = capture;
    try {
      const started = start(env);
      await started.handle.listening;
      await started.handle.stop("SIGTERM");
      expect(teardownLines(capture.lines, started.boundary())).toEqual(NORMAL_SEQUENCE);
    } finally {
      capture.stop();
      activeCapture = null;
    }
  });

  it("② 缺陷 A 核心：audit.flush 超时 ⇒ **绝不**打「audit flushed」，改打明确告警", async () => {
    const { env } = throwawayEnv();
    const restore = stubAuditFlush(() => new Promise<void>(() => {}));
    const capture = captureConsoleLog();
    activeCapture = capture;
    try {
      const started = start({ ...env, CELESTEA_SHUTDOWN_DRAIN_MS: FAST_DRAIN });
      await started.handle.listening;
      // 超时必须不挂住：stop() 仍然返回（W2014 的 resolve 语义没被改成抛错）。
      await expect(started.handle.stop("SIGTERM")).resolves.toBeUndefined();
      const lines = teardownLines(capture.lines, started.boundary());
      // ★ 缺陷 A 的核心断言：超时不得出现成功文案。
      expect(lines).not.toContain("audit flushed");
      expect(lines.some((l) => l.startsWith(AUDIT_TIMEOUT))).toBe(true);
      // 这一步之后的步骤照常进行（超时不是致命错误）。
      expect(lines).toContain("traffic stopped (listener closed, leftover sockets cut)");
    } finally {
      restore();
      capture.stop();
      activeCapture = null;
    }
  });

  it("③ W2014 语义未被破坏：stopTraffic 超时**不抛异常**，退出路径继续", async () => {
    const { env } = throwawayEnv();
    // drainMs 极小 + 一条确凿打开的 SSE 连接 ⇒ server.close() 必然来不及 resolve。
    const capture = captureConsoleLog();
    activeCapture = capture;
    try {
      const started = start({ ...env, CELESTEA_SHUTDOWN_DRAIN_MS: "40" });
      const bound = await started.handle.listening;
      const client = await openSse(bound.port);
      // 非空转前提：SSE 响应头**真的**到了（不是一个还没发出去的哑连接）。
      expect(client.head().startsWith("HTTP/1.1 200 ")).toBe(true);
      // 确定性前提：调用 stop 的这一刻连接确凿是打开的。
      // W1484 test B 已钉死：这种状态下 `server.close()` 在
      // `closeAllConnections()` 之前**不可能** resolve ⇒ 必然走超时分支。
      expect(client.closed()).toBe(false);
      const startedAt = Date.now();
      await expect(started.handle.stop("SIGTERM")).resolves.toBeUndefined();
      const elapsed = Date.now() - startedAt;
      // ★ 下界证据（不是「sleep 赌」，方向相反）：只有真的走满了 drainMs 预算
      //   才可能有这个耗时；若 close() 正常 resolve，耗时会是 ~0 ⇒ 断言变红。
      expect(elapsed).toBeGreaterThanOrEqual(40);
      const lines = teardownLines(capture.lines, started.boundary());
      expect(lines[0]).toBe("SIGTERM received — draining (grace 40ms)");
      // 超时被如实记录，而不是静默吞掉。
      expect(lines.some((l) => l.startsWith("teardown step failed"))).toBe(false);
      expect(lines).toContain("traffic stopped (listener closed, leftover sockets cut)");
      expect(lines).toContain("audit flushed");
    } finally {
      capture.stop();
      activeCapture = null;
    }
  });

  it("④ engine.shutdown 超时：同样如实告警，且不影响已完成的步骤", async () => {
    const { env } = throwawayEnv();
    const capture = captureConsoleLog();
    activeCapture = capture;
    try {
      const started = start(
        { ...env, CELESTEA_SHUTDOWN_TIMEOUT_MS: FAST_TEARDOWN },
        withHangingShutdown(createFakeRuntimeAdapter({ profile: { model: "test-model" } })),
      );
      await started.handle.listening;
      await expect(started.handle.stop("SIGTERM")).resolves.toBeUndefined();
      const lines = teardownLines(capture.lines, started.boundary());
      expect(lines).toContain("audit flushed");
      expect(lines.some((l) => l.startsWith(ENGINE_TIMEOUT))).toBe(true);
      expect(lines).not.toContain("engine stopped (workers settled, session logs closed) — loop may drain");
    } finally {
      capture.stop();
      activeCapture = null;
    }
  });

  it("⑥ 失败 ≠ 超时：audit.flush **抛错**时报 FAILED，不得被压成 TIMED OUT，更不得报成功", async () => {
    const { env } = throwawayEnv();
    const restore = stubAuditFlush(() => Promise.reject(new Error("disk gone")));
    const capture = captureConsoleLog();
    activeCapture = capture;
    try {
      const started = start({ ...env, CELESTEA_SHUTDOWN_DRAIN_MS: FAST_DRAIN });
      await started.handle.listening;
      // 失败同样不得挂住退出路径（W2014 语义：退出路径不因单步失败而抛）。
      await expect(started.handle.stop("SIGTERM")).resolves.toBeUndefined();
      const lines = teardownLines(capture.lines, started.boundary());
      // 原始错误如实上报（这条是既有的、没动过的行为）。
      expect(lines.some((l) => l.startsWith("teardown step failed: disk gone"))).toBe(true);
      // ★ 三态的核心：失败**不得**被说成超时，也不得被说成成功。
      expect(lines).not.toContain("audit flushed");
      expect(lines.some((l) => l.startsWith(AUDIT_TIMEOUT))).toBe(false);
      expect(lines.some((l) => l.startsWith("audit flush FAILED"))).toBe(true);
    } finally {
      restore();
      capture.stop();
      activeCapture = null;
    }
  });

  it("⑤ 缺陷 B：二次信号说实话（还在 drain），且**不**提前退出、不丢在途工作", async () => {
    const { env } = throwawayEnv();
    const capture = captureConsoleLog();
    activeCapture = capture;
    try {
      const started = start(env);
      await started.handle.listening;
      // 第一次 stop 在第一个 await 处让出后立刻发第二次 ⇒ stopping 必为 true。
      const first = started.handle.stop("SIGTERM");
      const second = started.handle.stop("SIGTERM");
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
      const lines = teardownLines(capture.lines, started.boundary());
      const again = lines.filter((l) => l.includes("again"));
      expect(again).toHaveLength(1);
      expect(again[0]).toContain(AGAIN_LINE);
      // ★ 不得再出现「立刻退出 / 丢弃在途工作」的谎言。
      expect(again[0]).not.toContain(OLD_LIE);
      expect(lines.join("\n")).not.toContain(OLD_LIE);
      // ★ 行为证据（比「文案对不对」强）：第二次信号在第一次 drain **尚未完成时**
      //   就打出了「already draining」，而**之后**完整的三步照常走完 ——
      //   证明它确实没有提前退出、没有丢弃在途工作（修复前这里同样走完，但文案说
      //   「exiting now / in-flight work is dropped」，即日志在说谎）。
      expect(lines).toEqual([
        NORMAL_SEQUENCE[0],
        "SIGTERM again — already draining (in-flight teardown continues; this call does not exit early)",
        NORMAL_SEQUENCE[1],
        NORMAL_SEQUENCE[2],
        NORMAL_SEQUENCE[3],
      ]);
    } finally {
      capture.stop();
      activeCapture = null;
    }
  });
});
