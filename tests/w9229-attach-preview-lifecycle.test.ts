// @vitest-environment jsdom
/**
 * W9229 · P2批次1（前端）—— 附件预览 objectURL 的**生命周期**（真实模块 + 真实 objectURL 计数）。
 *
 * 覆盖审计 results/W9201-消息渲染管线.md §P2 的四条资源生命周期发现：
 *   F-15 异步摘要完成前被移除的条目永远不被回收（还反过来挤掉**有效**预览）；
 *   F-16 previews 的键只有 attachment_id ⇒ 跨会话同内容附件互相顶掉 / 串读；
 *   F-17 drafts 按会话累积且永不释放（容器被淘汰后仍持有 File + objectURL）；
 *   F-18 同一条 objectURL 被「待发缩略图」与「已发送气泡」共用，无差别吊销会让气泡变碎图。
 *
 * 证据口径（刻意不用「函数被调用过」这种假证据）：
 *   · 真实 objectURL 计数：接管 URL.createObjectURL / revokeObjectURL，按 URL 记账；
 *   · 真实模块：pathToFileURL 动态 import apps/web/src/ui/attachments.ts（不复刻逻辑）；
 *   · 「已发送气泡」用真实形态的 <img src=blob:…> 节点表示（send.ts 渲染的就是它）。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;

const HTML = '<div id="messages"></div><textarea id="input" rows="2"></textarea>';
/**
 * 最小 DOM 形状（本仓 tests/** 的既有口径：根 tsconfig 不含 DOM lib，不引 Document/
 * HTMLElement 这些全局类型，用结构化接口描述真正用到的那几个成员）。
 */
interface ImgLike {
  src: string;
  getAttribute(k: string): string | null;
}
interface GridLike {
  querySelector(sel: string): ImgLike | null;
}
interface BodyLike {
  innerHTML: string;
  appendChild(n: unknown): unknown;
  replaceChildren(...n: unknown[]): void;
}
interface DocLike {
  body: BodyLike;
  createElement(t: string): ImgLike;
  querySelector(sel: string): unknown;
}
const doc = (globalThis as unknown as { document: DocLike }).document;

interface PendingLike { id: string; url: string; name: string; error: string }
interface AttMod {
  addFiles(files: ArrayLike<unknown>): number;
  pendingList(): PendingLike[];
  pendingCount(): number;
  removePending(item: PendingLike): void;
  takePending(key: string): PendingLike[];
  clearPending(): void;
  clearPendingImages(): number;
  pendingViews(items: readonly PendingLike[]): Array<{ url?: string }>;
  attachmentViewsOf(refs: readonly unknown[], session?: string): Array<{ url?: string }>;
}
interface ViewMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): unknown;
  activatePane(id: string, kind?: string, title?: string): unknown;
}

/** 接管 objectURL：按真实 URL 记账，供「吊销/未吊销」机械断言。 */
let urlSeq = 0;
let revoked: string[] = [];
function installObjectUrls(): void {
  urlSeq = 0;
  revoked = [];
  const u = globalThis.URL as unknown as {
    createObjectURL?: (f: unknown) => string;
    revokeObjectURL?: (url: string) => void;
  };
  u.createObjectURL = () => "blob:w9229-" + ++urlSeq;
  u.revokeObjectURL = (url: string) => { revoked.push(url); };
}

/**
 * 可控摘要：默认按字节内容派生稳定 id（同内容同 id），gate 版用来卡住 F-15 的时序。
 * ★ 签名必须与 crypto.subtle.digest 同形：`(algorithm, data)` —— 少写第一个参数会
 *   把算法名当成数据（实测踩到：mock 收到字符串 'SHA-256'，id 恒为空串）。
 */
type Digest = (algorithm: string, data: ArrayBuffer) => Promise<ArrayBuffer>;
const defaultDigest: Digest = async (_algorithm, data) => {
  const bytes = Array.from(new Uint8Array(data));
  return new TextEncoder().encode(bytes.join(".")).buffer as ArrayBuffer;
};
function stubDigest(impl?: Digest): void {
  vi.stubGlobal("crypto", { subtle: { digest: impl ?? defaultDigest } });
}

const makeFile = (name: string, bytes: number[]): unknown => ({
  name,
  type: "image/png",
  size: bytes.length,
  arrayBuffer: async (): Promise<ArrayBuffer> => new Uint8Array(bytes).buffer,
});

const refOf = (id: string): unknown => ({ attachment_id: id, media_type: "image/png", width: 4, height: 4 });

const flush = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * 真实「已发送气泡」形态：走**真实的** renderAttachmentGrid + pendingViews
 * （send.ts 的 startTurn 就是 `addUserMessage(ctx, t, { attachments: pendingViews(items) })`
 *  → user.ts 的 `bubble.appendChild(renderAttachmentGrid(atts))`），而不是手搓一个 <img>。
 * 手搓的 <img> 不带 .attach-grid/.attach-thumb，会让「谁还引用这条 URL」的判据测不到。
 */
let gridMod: { renderAttachmentGrid(views: unknown[]): GridLike } | null = null;
async function bubbleImg(url: string): Promise<ImgLike> {
  if (gridMod === null) {
    gridMod = (await import(/* @vite-ignore */ at("ui/attachment-view.ts"))) as unknown as {
      renderAttachmentGrid(views: unknown[]): GridLike;
    };
  }
  const grid = gridMod.renderAttachmentGrid([{ name: "a.png", url, bytes: 4 }]);
  doc.body.appendChild(grid);
  return grid.querySelector("img.attach-thumb") as ImgLike;
}

async function boot(): Promise<{ V: ViewMod; att: AttMod }> {
  const V = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as unknown as ViewMod;
  V.initViewCtx();
  V.ensurePane("s1", "session", "甲");
  V.activatePane("s1", "session", "甲");
  const att = (await import(/* @vite-ignore */ at("ui/attachments.ts"))) as unknown as AttMod;
  return { V, att };
}

beforeEach(() => {
  doc.body.innerHTML = HTML;
  vi.resetModules();
  installObjectUrls();
  stubDigest();
});
afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

describe("W9229 · F-15 异步摘要落地时该条目已被移除", () => {
  it("移除后摘要才落地 ⇒ 预览表里不得留下这条（否则会挤掉有效预览）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    stubDigest(async (algorithm, data) => { await gate; return defaultDigest(algorithm, data); });
    const { att } = await boot();
    att.addFiles([makeFile("a.png", [1, 2, 3])]);
    const item = att.pendingList()[0];
    expect(item).toBeDefined();
    if (!item) return;
    att.removePending(item);
    expect(revoked, "移除即吊销（既有 R3 W838-F1 语义）").toContain(item.url);
    release();
    await flush(10);
    expect(item.id, "前置：摘要确实落地并写了 id").not.toBe("");
    expect(
      att.attachmentViewsOf([refOf(item.id)], "s1")[0]?.url,
      "已移除的条目不得再登记进预览表（登记 = 用一条已吊销 URL 挤占上限）",
    ).toBeUndefined();
  });
});

describe("W9229 · F-16 预览登记的会话维度", () => {
  it("读预览必须限定会话：别的会话不得借到本条 URL", async () => {
    const { att } = await boot();
    att.addFiles([makeFile("a.png", [1, 2, 3])]);
    await flush();
    const item = att.pendingList()[0];
    expect(item).toBeDefined();
    if (!item) return;
    expect(att.attachmentViewsOf([refOf(item.id)], "s1")[0]?.url).toBe(item.url);
    expect(att.attachmentViewsOf([refOf(item.id)], "s2")[0]?.url).toBeUndefined();
  });

  it("两个会话上传同一张图：各自登记互不顶掉，且谁的 URL 都不泄漏", async () => {
    const { V, att } = await boot();
    att.addFiles([makeFile("a.png", [1, 2, 3])]);
    await flush();
    const a = att.pendingList()[0];
    expect(a).toBeDefined();
    if (!a) return;
    await bubbleImg(a.url); // 甲会话的气泡引用它（真实形态）
    V.activatePane("s2", "session", "乙");
    att.addFiles([makeFile("a.png", [1, 2, 3])]); // 同字节 ⇒ 同 attachment_id
    await flush();
    const b = att.pendingList()[0];
    expect(b).toBeDefined();
    if (!b) return;
    expect(b.id, "前置：同内容必须得到同一个 attachment_id").toBe(a.id);
    expect(b.url).not.toBe(a.url);
    expect(att.attachmentViewsOf([refOf(a.id)], "s1")[0]?.url, "甲的条目被乙顶掉了").toBe(a.url);
    expect(att.attachmentViewsOf([refOf(a.id)], "s2")[0]?.url).toBe(b.url);
    expect(revoked, "被气泡引用的 URL 不得因跨会话登记而被吊销").not.toContain(a.url);
  });
});

describe("W9229 · F-17 drafts 随会话数无界累积", () => {
  it("20 个会话各挂一张未发送图 ⇒ 待发区必须按容器上限回收最旧会话", async () => {
    const { V, att } = await boot();
    for (let i = 0; i < 20; i++) {
      V.activatePane("d" + i, "session", "会话" + i);
      att.addFiles([makeFile("f" + i + ".png", [i, i + 1, i + 2])]);
      await flush(3);
    }
    V.activatePane("d0", "session", "会话0");
    expect(
      att.pendingList().length,
      "容器已被淘汰的会话（>MAX_PANES）不得继续持有待发项",
    ).toBe(0);
    V.activatePane("d19", "session", "会话19");
    expect(att.pendingList().length, "最近使用的会话必须保留").toBe(1);
  });
});

describe("W9229 · F-18 同一条 objectURL 的两个消费者", () => {
  it("clearPending 不得吊销已发送气泡仍在引用的 URL", async () => {
    const { att } = await boot();
    att.addFiles([makeFile("a.png", [1, 2, 3])]);
    await flush();
    const items = att.takePending("s1");
    expect(items.length).toBe(1);
    const url = att.pendingViews(items)[0]?.url ?? "";
    expect(url).not.toBe("");
    await bubbleImg(url); // 已发送气泡
    att.clearPending();
    expect(revoked, "已发送气泡的 URL 被 clearPending 吊销了").not.toContain(url);
    expect(att.attachmentViewsOf([refOf(items[0]!.id)], "s1")[0]?.url).toBe(url);
  });

  it("切会话不得吊销已发送气泡仍在引用的 URL；未被引用的照旧吊销（正对照）", async () => {
    const { V, att } = await boot();
    att.addFiles([makeFile("a.png", [1, 2, 3])]);
    await flush();
    const sent = att.pendingList()[0];
    expect(sent).toBeDefined();
    if (!sent) return;
    await bubbleImg(sent.url); // 已发送气泡
    att.addFiles([makeFile("b.png", [9, 9, 9])]);
    await flush();
    const pending = att.pendingList().find((p) => p.id !== sent.id);
    expect(pending).toBeDefined();
    if (!pending) return;
    V.activatePane("s3", "session", "丙");
    expect(revoked, "气泡引用的 URL 不得被切会话吊销").not.toContain(sent.url);
    expect(revoked, "无人引用的待发 URL 必须照旧吊销（证明豁免是有判据的，不是一刀切）").toContain(pending.url);
  });
});
