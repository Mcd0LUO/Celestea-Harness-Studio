/**
 * helper 的 stdio 客户端（NDJSON over stdio，规划 §5）。
 *
 * 协议真源是**移植后的 Rust 源码**（packages/desktop/helper/src），不是任何参考仓：
 *   - 请求：`{id, method, params, meta}`（protocol.rs::encode_request 的同形子集；
 *     meta 可省，helper 的 `Request` 三个字段都有 `#[serde(default)]`）
 *   - 响应：`{id, ok:true, result}` / `{id, ok:false, error}`
 *     （protocol.rs::official_ok / official_err）
 *   - 截图：**只在 `method:"call"` 这条路上**被拆到 `result.images`
 *     （main.rs 的 call 分支 + images.rs::detach_images，形状 `{mimeType,data,name}`）。
 *     直接按方法名调用的话截图是内联 data URL —— 所以工具一律走 call，
 *     这样「截图走 images 字段」是结构保证的，不是约定。
 *
 * 生命周期（规划 §5：静态检查决定挂不挂、懒启动决定跑不跑）：
 *   - 挂不挂由 desktop-wiring 在 mount 时静态判定，本文件**不**做平台/存在性判断；
 *   - 第一次调用才 spawn + 握手 ping；握手失败 → 本次结构化错误 + degraded；
 *   - 下一次调用允许重启一次；再失败 → 保持 degraded 并继续报结构化错误
 *     （绝不静默重试循环）。
 *
 * 三个刻意的不作为：
 *   1. **不杀 helper 的超时**：超时只了结这一次 pending，进程留着（见常量注释）。
 *   2. **单例**：一个 helper 进程服务整代引擎（helper 自己是多路复用的：id 配对、
 *      输入类动作在它内串行），所以这里不按工具建连接。
 *   3. **不吞 stderr**：helper 的诊断走它自己的文件，但启动期的 spawn 错误必须
 *      落到可读的地方，否则「起不来」就只剩一句没有线索的 handshake_failed。
 */

import { spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  DESKTOP_CALL_TIMEOUT_MS,
  DESKTOP_HANDSHAKE_TIMEOUT_MS,
  DESKTOP_SUPPORTED_PLATFORM,
  DesktopError,
  HELPER_APPROVED_APP_META_KEY,
  HELPER_BUDGET_META_KEY,
  HELPER_HANDSHAKE_METHOD,
  READ_ONLY_METHODS,
  type DesktopChildProcess,
  type DesktopClientOptions,
  type DesktopSpawner,
  type HelperCallResult,
  type HelperHandshake,
  type HelperImage,
} from "./types.js";

/**
 * 一份**由闸门判决带来**的应用批准。
 *
 * 形状带标签是刻意的：客户端的 fail-closed 只认两种来源——带标签的闸门放行，或只读
 * 白名单内的预置。工具层想给写方法塞一个裸字符串进来骗过闸门，会被这条拒掉。
 */
export interface GateApproval {
  via: "gate";
  app: string;
}

/** Context 里的客户端 token（token 属于提供它的模块，core 只留 seam 级 token）。 */
export const DESKTOP_CLIENT_SERVICE = "celestea.desktop.HelperClient";

interface Pending {
  resolve(value: unknown): void;
  reject(error: DesktopError): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Envelope {
  id?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: unknown;
}

/** helper 报出来的错误原文（不翻译：模型需要看到 helper 的真实句子）。 */
function helperErrorText(envelope: Envelope): string {
  if (typeof envelope.error === "string" && envelope.error.trim() !== "") return envelope.error;
  return "helper reported a failure without an error message";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class DesktopHelperClient {
  private readonly options: Required<Omit<DesktopClientOptions, "spawn" | "stderr">> & {
    spawn: DesktopSpawner;
    stderr: { write(chunk: string): unknown };
  };
  private child: DesktopChildProcess | null = null;
  /** 正在进行的 spawn+握手；并发调用共用同一次启动（这是「单例」的具体含义）。 */
  private starting: Promise<void> | null = null;
  private buffer = "";
  /** Per-connection UTF-8 decoders (split multi-byte characters across chunks). */
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** 上一次连续失败的性质；成功即清零。null = 健康。 */
  private degradedReason: string | null = null;
  private closed = false;

  constructor(options: DesktopClientOptions) {
    this.options = {
      helperPath: options.helperPath,
      // 缺省值只在这一处（形参注入的仓内先例：packages/tools/src/platform/paths.ts）。
      platform: options.platform ?? process.platform,
      timeoutMs: options.timeoutMs ?? DESKTOP_CALL_TIMEOUT_MS,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? DESKTOP_HANDSHAKE_TIMEOUT_MS,
      env: options.env ?? process.env,
      spawn: options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, [...args], { env: spawnOptions.env as NodeJS.ProcessEnv, windowsHide: spawnOptions.windowsHide, stdio: ["pipe", "pipe", "pipe"] })),
      stderr: options.stderr ?? process.stderr,
    };
  }

  /** 连续失败的原因（面板/诊断用）；null = 上一次调用成功或还没调用过。 */
  get degraded(): string | null {
    return this.degradedReason;
  }

  /** helper 是否已经在跑（面板/测试用；不 spawn）。 */
  get running(): boolean {
    return this.child !== null;
  }

  /**
   * 引擎关闭时杀 helper（规划 §5 的回收）。
   *
   * 注意：core 的 `Plugin` 没有 unmount 原语、`Context` 也没有 effect，所以
   * 「ctx.effect 逆操作」在本仓落不了地——真实的回收 seam 是 compose 的
   * `shutdownHooks`（desktop-wiring 在那里挂这个 stop）。这里是幂等的：
   * 已经停了再调一次不会二次 kill。
   */
  stop(): void {
    this.closed = true;
    this.failAll(new DesktopError("helper_crashed", "desktop helper client was stopped"));
    const child = this.child;
    this.child = null;
    if (child === null) return;
    try {
      child.kill();
    } catch (e) {
      this.note(`[celestea-desktop] killing the helper failed: ${String(e)}\n`);
    }
  }

  /** 握手（幂等：已握手过的进程不重复握手，除非它已经退出）。 */
  async handshake(): Promise<HelperHandshake> {
    await this.ensureStarted();
    const value = this.handshakeValue;
    // ensureStarted 成功 = start() 跑完 = handshakeValue 一定被赋值；这个 null 分支
    // 只在 start() 的某条早退路径上可达，而那些路径都已经抛错了。写成显式抛错而不是
    // 非空断言：断言会被断言检查关掉，而这里是「真发生了就说清楚」。
    if (value === null) throw new DesktopError("handshake_failed", "the desktop helper started but recorded no handshake");
    return value;
  }

  private handshakeValue: HelperHandshake | null = null;

  /**
   * 调一个 helper 工具。
   *
   * `approvedApp` 的**形状**决定它能不能被接受：
   *
   *   - `{ via: "gate", app }` —— 来自闸门判决（gate.ts）。写方法只有这条路能拿到
   *     应用批准，因为授权语义只存在于闸门里。
   *   - 裸字符串 —— M1 的只读预置（types.ts::READ_ONLY_METHODS）。它在**写**方法上
   *     直接抛错：这条 fail-closed 保持不变，否则「工具层自行预置批准」就是一条绕开
   *     闸门的暗道。
   *
   * 不传 = 交给 helper 自己解析（只读发现类方法本来就不需要）。
   */
  async callTool(method: string, args: Record<string, unknown>, approvedApp?: string | GateApproval): Promise<HelperCallResult> {
    if (this.closed) throw new DesktopError("helper_crashed", "desktop helper client is stopped");
    if (approvedApp !== undefined && approvedApp !== "" && typeof approvedApp !== "object" && !READ_ONLY_METHODS.includes(method)) {
      // fail-closed：这个分支一旦被触发，说明有人想给非只读方法开预置批准。
      throw new DesktopError("tool_error", `method ${method} is not read-only: pre-granted app approval does not apply to it`);
    }
    // 每次调用至多一次「崩溃后重启」；再失败就是 degraded 的结构化错误。
    try {
      return this.settle(await this.callOnce(method, args, approvedApp));
    } catch (e) {
      if (!isRetryable(e)) throw this.markDegraded(e);
      this.killChild();
      try {
        return this.settle(await this.callOnce(method, args, approvedApp));
      } catch (second) {
        throw this.markDegraded(second);
      }
    }
  }

  /** 一次成功调用即清零 degraded（规划 §5：握手/调用成功后清零）。 */
  private settle(result: HelperCallResult): HelperCallResult {
    this.degradedReason = null;
    return result;
  }

  private async callOnce(method: string, args: Record<string, unknown>, approvedApp?: string | GateApproval): Promise<HelperCallResult> {
    await this.ensureStarted();
    const meta: Record<string, unknown> = { [HELPER_BUDGET_META_KEY]: this.options.timeoutMs };
    const app = typeof approvedApp === "object" ? approvedApp.app : approvedApp;
    if (app !== undefined && app !== "") meta[HELPER_APPROVED_APP_META_KEY] = app;
    // 永远走 method:"call"：只有这条路上 helper 才把截图拆到 result.images
    // （main.rs 的 call 分支）。按方法名直调的话截图是内联 data URL，会一路
    // 以文本形式进模型——helper/src/images.rs 的注释把这条写成了硬规则。
    const response = await this.request({ method: "call", params: { name: method, arguments: args }, meta });
    return this.readCallEnvelope(response, method);
  }

  private readCallEnvelope(response: unknown, method: string): HelperCallResult {
    const envelope = this.envelopeOf(response, method);
    const result = envelope.result;
    if (!isRecord(result)) {
      throw new DesktopError("protocol_error", `helper ${method} returned no result object`);
    }
    if (result["ok"] !== true) {
      // call 分支自己也会带 ok:false（gate_and_dispatch 的错误走 official_err，
      // 所以正常情况下这一层已经被 envelope.ok 拦掉；留着是为了将来 helper 改了
      // 错误形状时，我们仍然给出结构化错误而不是把半个结果当成功）。
      throw new DesktopError("tool_error", typeof result["error"] === "string" ? result["error"] : `helper ${method} failed`);
    }
    return { value: result["value"] ?? null, images: readImages(result["images"]) };
  }

  private envelopeOf(value: unknown, method: string): Envelope {
    if (!isRecord(value)) throw new DesktopError("protocol_error", `helper ${method} returned a non-object envelope`);
    const envelope = value as Envelope;
    if (envelope.ok !== true) {
      throw new DesktopError("tool_error", helperErrorText(envelope), { method });
    }
    return envelope;
  }

  private async ensureStarted(): Promise<void> {
    // `starting` FIRST, then `child`. The order is load-bearing: start() assigns
    // `this.child` the moment the process is spawned but keeps `this.starting` set
    // until the ping handshake resolves, so checking `child` first would let a
    // second caller sail through a window in which nothing is ready — its
    // handshake() would fail with a phantom handshake_failed, and its callTool
    // would write a business request into a helper that has not said hello yet.
    if (this.starting !== null) return this.starting;
    if (this.child !== null) return;
    this.starting = this.start()
      .catch((e: unknown) => {
        // 启动失败不留半开的 child：下一次调用要能干净地重来。
        this.child = null;
        this.handshakeValue = null;
        throw e;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  private async start(): Promise<void> {
    if (this.options.platform !== DESKTOP_SUPPORTED_PLATFORM) {
      throw new DesktopError("unsupported_platform", `desktop tools need the ${DESKTOP_SUPPORTED_PLATFORM} helper; this host is ${this.options.platform}`);
    }
    let child: DesktopChildProcess;
    try {
      child = this.options.spawn(this.options.helperPath, ["--parent-pid", String(process.pid)], {
        env: this.options.env,
        windowsHide: true,
      });
    } catch (e) {
      throw new DesktopError("spawn_failed", `cannot spawn the desktop helper at ${this.options.helperPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (child === null || child === undefined) {
      throw new DesktopError("spawn_failed", `spawning the desktop helper at ${this.options.helperPath} returned no process`);
    }
    this.child = child;
    this.buffer = "";
    child.on("error", (e: unknown) => {
      this.note(`[celestea-desktop] helper process error: ${String(e)}\n`);
      this.onChildGone(new DesktopError("spawn_failed", `the desktop helper process failed: ${e instanceof Error ? e.message : String(e)}`));
    });
    child.on("exit", (code: unknown) => {
      this.onChildGone(new DesktopError("helper_crashed", `the desktop helper exited with code ${String(code)}`));
    });
    child.stdout?.on("data", (chunk: unknown) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: unknown) => {
      // Same reasoning as stdout: helper stderr carries window/process names too.
      const text = this.stderrDecoder.write(asBuffer(chunk));
      if (text.trim() !== "") this.note(`[celestea-desktop] helper stderr: ${text}`);
    });
    // 握手走 ping：它刻意绕开 turn 中断 / 桌面锁 / 托管策略闸门（main.rs 的 ping
    // 分支），所以「helper 能不能用」永远不会被「当前不许用」误报成「起不来」。
    //
    // 任何失败都归一成 handshake_failed：调用方要回答的是同一个问题——「这个
    // helper 能不能用」，而不是「这一次 ping 具体坏在哪」（timeout / protocol_error
    // 的细节进 detail，代码层面仍可分辨）。
    let envelope: Envelope;
    try {
      const raw = await this.request({ method: HELPER_HANDSHAKE_METHOD, params: {} }, this.options.handshakeTimeoutMs);
      // envelopeOf 在 try 之内：helper 答 `{ok:false}` 与「没答」回答的是同一个问题
      // （这个 helper 能不能用），所以两条路径必须落成同一个 code，否则调用方要同时
      // 认 handshake_failed 和 tool_error 才能回答「helper 能不能用」。
      envelope = this.envelopeOf(raw, HELPER_HANDSHAKE_METHOD);
    } catch (e) {
      const inner = e instanceof DesktopError ? e : new DesktopError("protocol_error", e instanceof Error ? e.message : String(e));
      throw new DesktopError("handshake_failed", `the desktop helper did not complete the ping handshake: ${inner.message}`, { cause: inner.code });
    }
    const value = envelope.result;
    if (!isRecord(value) || typeof value["version"] !== "string" || value["platform"] !== DESKTOP_SUPPORTED_PLATFORM || !Array.isArray(value["features"])) {
      throw new DesktopError("handshake_failed", "the desktop helper answered ping without a {version, platform, features} envelope", { result: value ?? null });
    }
    this.handshakeValue = {
      version: value["version"],
      platform: value["platform"],
      features: (value["features"] as unknown[]).filter((f): f is string => typeof f === "string"),
    };
  }

  /** 一发请求一收响应；超时只了结这一发（不动 helper）。 */
  private request(body: { method: string; params: unknown; meta?: Record<string, unknown> }, timeoutMs?: number): Promise<unknown> {
    const child = this.child;
    if (child === null || child.stdin === null) {
      return Promise.reject(new DesktopError("spawn_failed", "the desktop helper process has no stdin"));
    }
    const id = this.nextId++;
    const line = JSON.stringify({ id, method: body.method, params: body.params ?? {}, ...(body.meta === undefined ? {} : { meta: body.meta }) });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 迟到的响应会被 onStdout 按 id 找不到 pending 而丢弃——这是「杀调用不杀
        // helper」的实现：调用了结，进程留着，它的 id 空间继续用。
        this.pending.delete(id);
        reject(new DesktopError("timeout", `the desktop helper did not answer ${body.method} within ${timeoutMs ?? this.options.timeoutMs}ms`));
      }, timeoutMs ?? this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin?.write(line + "\n");
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new DesktopError("spawn_failed", `cannot write to the desktop helper: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  private onStdout(chunk: unknown): void {
    // A StringDecoder, NOT chunk.toString('utf8'): stdio delivers **arbitrary**
    // byte boundaries, so a multi-byte character (a Chinese window title, an
    // emoji) can straddle two chunks. Decoding each chunk independently turns
    // the split character into U+FFFD — a silent corruption of the one field
    // (titles) a desktop tool exists to report. The decoder holds the partial
    // tail and prepends it to the next chunk.
    this.buffer += this.stdoutDecoder.write(asBuffer(chunk));
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== "") this.dispatch(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.note(`[celestea-desktop] ignoring a non-JSON helper line: ${line.slice(0, 200)}\n`);
      return;
    }
    const rawId = isRecord(parsed) ? parsed["id"] : undefined;
    const id = typeof rawId === "number" ? rawId : null;
    const entry = id === null ? undefined : this.pending.get(id);
    if (id === null || entry === undefined) return; // 迟到的响应（超时后）或 helper 的主动通知
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(parsed);
  }

  private onChildGone(error: DesktopError): void {
    if (this.child === null) return;
    this.child = null;
    this.handshakeValue = null;
    this.buffer = "";
    this.failAll(error);
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    this.handshakeValue = null;
    if (child === null) return;
    try {
      child.kill();
    } catch (e) {
      this.note(`[celestea-desktop] killing the crashed helper failed: ${String(e)}\n`);
    }
  }

  private failAll(error: DesktopError): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private markDegraded(e: unknown): DesktopError {
    const error = e instanceof DesktopError ? e : new DesktopError("tool_error", e instanceof Error ? e.message : String(e));
    this.degradedReason = `${error.code}: ${error.message}`;
    return error;
  }

  private note(text: string): void {
    this.options.stderr.write(text);
  }
}

/** 崩溃类失败值得重启一次；参数错误/超时重试只会把同一个错再犯一遍。 */
function isRetryable(e: unknown): boolean {
  if (!(e instanceof DesktopError)) return false;
  return e.code === "helper_crashed" || e.code === "spawn_failed" || e.code === "handshake_failed";
}

/**
 * The raw bytes of one stdio chunk (what a StringDecoder needs).
 *
 * A stdio stream hands over Buffers. A **string** can only appear from a test
 * fixture or an already-decoded stream; in that case its characters are
 * re-encoded to UTF-8 so the decoder sees one consistent byte stream (this
 * also keeps the split-character test honest: a fixture that splits by
 * character would otherwise be decoded as a string and hide the bug).
 */
function asBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(String(chunk), "utf8");
}

function readImages(value: unknown): readonly HelperImage[] {
  if (!Array.isArray(value)) return [];
  const out: HelperImage[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const mimeType = item["mimeType"];
    const data = item["data"];
    if (typeof mimeType !== "string" || typeof data !== "string") continue;
    const name = item["name"];
    out.push({ mimeType, data, ...(typeof name === "string" ? { name } : {}) });
  }
  return out;
}
