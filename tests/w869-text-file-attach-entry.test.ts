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
 *   的**第 ~①（三入口 + 待发区）~ 部分**（原文件 11 条几乎等长，单条 0.1–1.5s，文件 6.3–9.5s）。
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

function drop(files: unknown[]): void {
  const e = new Ev("drop", { bubbles: true }) as { dataTransfer?: unknown };
  e.dataTransfer = { types: ["Files"], files };
  (doc.getElementById("inputbar") as El).dispatchEvent(e);
}
function select(files: unknown[]): void {
  const input = doc.getElementById("attachInput") as El;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Ev("change"));
}
const items = (): El[] => Array.from(doc.querySelectorAll(".attach-tray .attach-item"));
const subs = (): string[] => Array.from(doc.querySelectorAll(".attach-tray .attach-sub")).map((e) => e.textContent ?? "");
const errs = (): number => items().filter((e) => e.className.indexOf("err") >= 0).length;

describe("W869 · 文本文件三入口 + 待发区", () => {
  beforeEach(() => { doc.body.innerHTML = HTML; vi.resetModules(); installGlobals(); turns.length = 0; });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it("① 拖入 .md + 选择 .txt：都进待发区，显示文件名与大小（当帧可见）", async () => {
    await boot();
    await flush(12);
    drop([textFile("notes.md", "text/markdown", "# 标题\n正文")]);
    expect(items().length).toBe(1); // 当帧入列，不等读取
    select([textFile("memo.txt", "text/plain", "第一行\n第二行")]);
    expect(items().length).toBe(2);
    const names = Array.from(doc.querySelectorAll(".attach-tray .attach-name")).map((e) => e.textContent);
    expect(names).toEqual(["notes.md", "memo.txt"]);
    expect(subs()[0]).toContain("文本"); // 大小 + 文本标识
    expect(subs()[0]).toContain("B");
    expect(errs()).toBe(0);
    await flush(); // 文本读取落定后仍不标红
    expect(errs()).toBe(0);
    const pending = (await importAtt()).pendingList();
    expect(pending.map((p) => p.kind)).toEqual(["text", "text"]);
    expect(pending[0]?.text).toBe("# 标题\n正文");
    // W869×W867 合并守护：文本项在展示夹里给「文」字形（不是按扩展名猜的通用首字），
    // 且绝不放 <img>（文本没有缩略图，不假装有图）。
    const glyphs = Array.from(doc.querySelectorAll(".attach-tray .attach-thumb-meta")).map((e) => e.textContent);
    expect(glyphs, "文本项的字形是「文」").toEqual(["文", "文"]);
    expect(doc.querySelectorAll(".attach-tray img.attach-thumb").length).toBe(0);
  });

  it("⑤ 未知扩展名但内容是 UTF-8 文本：拖入照收，正文读得出来", async () => {
    await boot();
    await flush(12);
    drop([textFile("README", "", "héllo wörld")]); // 无扩展名、无 MIME
    expect(items().length).toBe(1);
    await flush();
    expect(errs()).toBe(0);
    const pending = (await importAtt()).pendingList();
    expect(pending[0]?.text).toBe("héllo wörld");
  });
});
