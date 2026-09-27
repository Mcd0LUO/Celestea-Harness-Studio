// @vitest-environment jsdom
/**
 * W869 · 文本文件附件（.md/.txt/…）—— jsdom 真实模块用例。
 *
 * 用户原话：「前端:为什么不支持上传 md,txt 等文本文件？？？」
 * 设计决定（W869 报告详述）：文本走「前端读文本 + 发送时注入消息文本」，**不进**
 * attachments/ 存储、不新增后端类型；图片路径逐字节不变（仍走内联 base64 数组）。
 *
 * 本文件用 pathToFileURL 加载**真实模块**、派发**真实 DOM 事件**，覆盖：
 *   ① 拖入 .md / 选择 .txt → 进待发区并显示文件名与大小；
 *   ② 发送请求体含文本注入块（文件名 + 正文 + 定界行），纯图片消息的 attachments
 *      数组语义逐字节不变；
 *   ③ 超限文本被拒且原因是可见文案（不是静默丢弃）；
 *   ④ 二进制伪装成 .txt（含 NUL / 非法 UTF-8）被拒且不静默；
 *   ⑤ 未知扩展名但内容是可读 UTF-8 → 接受；
 *   ⑥ 文本不受「图像能力位」影响（逐文件判定：图片红、文本照收）。
 *
 * ★ W9220（测试提速，用例与断言逐字未动）：本文件是原 ~tests/w869-text-file-attach.test.ts~
 *   的**第 ~③（拒绝路径）~ 部分**（原文件 11 条几乎等长，单条 0.1–1.5s，文件 6.3–9.5s）。
 *   vitest 以**文件**为调度单位，拆开后三部分可并行。夹具（~HTML~/~installGlobals~/
 *   ~items~/~subs~/~errs~/~note~/~body~/~send~ 与各自的 beforeEach/afterEach）逐字
 *   复制自原文件 —— 每个新文件都带**自己的** beforeEach 重置，不共享跨文件状态。
 *   （W9219 的教训：共享夹具 + 缺重置 = 跨文件泄漏。）
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface El {
  id: string;
  className: string;
  textContent: string | null;
  value: string;
  disabled: boolean;
  title: string;
  accept: string;
  type: string;
  classList: { toggle(c: string, on?: boolean): boolean; contains(c: string): boolean; add(c: string): void };
  addEventListener(t: string, f: (e: unknown) => void): void;
  dispatchEvent(e: unknown): boolean;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): ArrayLike<El>;
  appendChild(n: El): El;
  replaceChildren(...n: El[]): void;
  remove(): void;
  click(): void;
}
interface Doc {
  body: El & { innerHTML: string };
  getElementById(id: string): El | null;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): ArrayLike<El>;
  addEventListener(t: string, f: (e: unknown) => void): void;
}

const doc = (globalThis as unknown as { document: Doc }).document;
const Ev = (globalThis as unknown as { Event: new (t: string, i?: { bubbles?: boolean }) => unknown }).Event;
const FileCtor = (globalThis as unknown as { File: new (p: unknown[], n: string, o?: unknown) => unknown }).File;
const enc = new TextEncoder();
const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;

const HTML =
  '<div id="app"><div id="layout"><main id="main"><div id="messages"></div>' +
  '<div id="statusline"><div class="sl-row sl-row-main">' +
  '<span class="sl-ctx" id="slCtx">—/—</span><button class="sl-model" id="slModel">—</button>' +
  '<span class="sl-spacer"></span><button id="slStop" class="sl-stop hidden"></button>' +
  '<span class="sl-hint" id="slHint"></span></div>' +
  '<div class="sl-row sl-row-sub"><div id="sessionBar"></div></div></div>' +
  '<footer id="statusbar"><span class="dot" id="statusDot"></span><span id="statusText"></span>' +
  '<span id="statusTurn"></span><span id="statusStep"></span><span id="statusTime"></span></footer>' +
  '<div id="inputbar"><textarea id="input" rows="2"></textarea>' +
  '<div class="input-side"><button id="btnMode" class="hidden">插话</button>' +
  '<button id="btnSend">发送</button></div></div></main></div></div>';

const net = {
  health: { ok: true, capabilities: { multimodal: true } } as Record<string, unknown>,
  config: { ok: true, model: "glm-5.3-flash" } as Record<string, unknown>,
  providers: { ok: true, providers: [] } as Record<string, unknown>,
  turnStatus: 202,
  turnPayload: { ok: true, turn: 1 } as Record<string, unknown>,
};
const reply = (status: number, payload: unknown): unknown => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
const flush = async (n = 24): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const fileOf = (name: string, type: string, bytes: number[] | Uint8Array): unknown =>
  new FileCtor([bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)], name, { type });
const textFile = (name: string, type: string, text: string): unknown => fileOf(name, type, enc.encode(text));

function installGlobals(): void {
  net.health = { ok: true, capabilities: { multimodal: true } };
  net.config = { ok: true, model: "glm-5.3-flash" };
  net.providers = { ok: true, providers: [] };
  vi.stubGlobal("fetch", async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.startsWith("/api/health")) return reply(200, net.health);
    if (u.startsWith("/api/config")) return reply(200, net.config);
    if (u.startsWith("/api/providers")) return reply(200, net.providers);
    if (u === "/api/turn") { turns.push(String((init as { body?: unknown } | undefined)?.body ?? "")); return reply(net.turnStatus, net.turnPayload); }
    return reply(200, { ok: true });
  });
  const url = globalThis.URL as unknown as { createObjectURL?: (f: unknown) => string; revokeObjectURL?: (u: string) => void };
  url.createObjectURL = () => "blob:w869";
  url.revokeObjectURL = () => {};
}

type AttMod = {
  addFiles(f: ArrayLike<unknown>): number;
  pendingList(): Array<{ name: string; bytes: number; kind?: string; text?: string; error: string }>;
  pendingCount(): number;
};
type BarMod = { refreshAttachmentTray(): void; refreshAttachmentEntry(): void };

const turns: string[] = [];

async function boot(): Promise<{ bar: BarMod; view: { activatePane(id: string, kind?: string, title?: string): unknown } }> {
  const view = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as {
    initViewCtx(): void; ensurePane(id: string, kind?: string, title?: string): unknown;
    activatePane(id: string, kind?: string, title?: string): unknown;
  };
  view.initViewCtx();
  view.ensurePane("ws/s1", "session", "甲会话");
  view.activatePane("ws/s1", "session", "甲会话");
  const bar = (await import(/* @vite-ignore */ at("ui/inputbar.ts"))) as BarMod;
  (bar as unknown as { initInputBar(h: unknown): void }).initInputBar({ send: () => {}, cancel: () => {} });
  return { bar, view };
}

const importAtt = async (): Promise<AttMod> => (await import(/* @vite-ignore */ at("ui/attachments.ts"))) as unknown as AttMod;

function select(files: unknown[]): void {
  const input = doc.getElementById("attachInput") as El;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Ev("change"));
}
const items = (): El[] => Array.from(doc.querySelectorAll(".attach-tray .attach-item"));
const subs = (): string[] => Array.from(doc.querySelectorAll(".attach-tray .attach-sub")).map((e) => e.textContent ?? "");
const errs = (): number => items().filter((e) => e.className.indexOf("err") >= 0).length;
const note = (): string => (doc.querySelector(".attach-note") as El | null)?.textContent ?? "";


describe("W869 · 拒绝路径（可执行原因，不静默）", () => {
  beforeEach(() => { doc.body.innerHTML = HTML; vi.resetModules(); installGlobals(); turns.length = 0; });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it("③ 超限文本（>256 KiB）被拒：待发区标红 + 原因可见", async () => {
    await boot();
    await flush(12);
    select([fileOf("big.md", "text/markdown", new Uint8Array(256 * 1024 + 1))]);
    expect(items().length).toBe(1);
    expect(errs()).toBe(1);
    expect(subs()[0]).toContain("文本文件不超过");
    expect(subs()[0]).toContain("256.0 KB");
    expect(note()).toContain("不符合要求"); // 可见提示，不是静默丢弃
    expect((await importAtt()).pendingCount()).toBe(0); // 不计入可发送
  });

  it("④ 二进制伪装成 .txt（含 NUL / 非法 UTF-8）被拒且不静默", async () => {
    await boot();
    await flush(12);
    select([fileOf("null.txt", "text/plain", [0x41, 0x00, 0x42]), fileOf("latin.txt", "text/plain", [0xff, 0xfe, 0x41])]);
    await flush();
    expect(items().length).toBe(2); // 不静默丢：留在待发区
    expect(errs()).toBe(2);
    expect(subs()[0]).toContain("UTF-8");
    expect(subs()[1]).toContain("二进制");
    expect((await importAtt()).pendingCount()).toBe(0);
  });

  it("⑥ 图像能力位只挡图片：text-only 模型下 .md 照收、同一批的 .png 被拦并给原因", async () => {
    net.config = { ok: true, model: "textonly" };
    net.providers = { ok: true, providers: [{ id: "p", models: [{ id: "textonly", input_modalities: ["text"] }] }] };
    await boot();
    await flush(12);
    select([textFile("spec.md", "text/markdown", "# 规格"), fileOf("shot.png", "image/png", [137, 80, 78, 71])]);
    await flush();
    expect(items().length).toBe(1); // 只有文本项进待发区（图片在入口被拦，不制造必然失败的请求）
    expect(errs()).toBe(0);
    expect(note()).toContain("不含图像"); // 图片被拦的可执行原因可见
    const pending = (await importAtt()).pendingList();
    expect(pending.length).toBe(1);
    expect(pending[0]?.kind).toBe("text");
    expect(pending[0]?.text).toBe("# 规格");
  });

  it("⑥ 对照：图像能力位可用时同一批两张都进（证明上面拦的是图片而不是文本）", async () => {
    await boot();
    await flush(12);
    select([textFile("spec.md", "text/markdown", "# 规格"), fileOf("shot.png", "image/png", [137, 80, 78, 71])]);
    await flush();
    expect(items().length).toBe(2);
    expect(errs()).toBe(0);
    expect((await importAtt()).pendingCount()).toBe(2);
  });
});
