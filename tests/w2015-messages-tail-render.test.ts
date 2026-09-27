// @vitest-environment jsdom
/**
 * W2015 · 前端侧门禁：**裁剪路径与全量路径渲染出的消息序列必须相同**。
 *
 * 为什么需要这条（而不是只测「字节少了」）：只断言字节数会奖励**无脑截断** ——
 * 一个把窗口改成 5 条的实现照样能通过字节门禁，但用户会丢掉 195 条他本来能看到的
 * 历史。本文件用**同一条历史**分别走两条真实路径：
 *   · 全量路径：服务端回全部（旧后端 / 未裁剪），前端自己 slice(-200)；
 *   · 裁剪路径：服务端回 tail=201（新后端），前端 slice(-200)。
 * 断言两边渲染出的 DOM 列序列逐字相同 —— 于是「省字节」不得以「少渲染」为代价。
 *
 * 走**真实模块**（ui/restore.ts + 真实渲染器），只把 fetch 换成可控服务端：
 * 服务端行为按请求里的 `tail` 参数如实模拟（回最后 N 条），不伪造响应形状。
 *
 * 变异负控制（报告 §变异负控制 贴红→绿原文）：
 *   M2 把裁剪窗口改成 5（服务端只回 5 条）⇒ 本文件的「列序列相同」断言必红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, doc, flush, HTML, resetHarness } from "./lib/w795-dom.js";

const SESSION = "ws/s1";
/** 渲染窗口（与 ui/restore.ts 的 MAX_RESTORE 同口径；用例里再独立断言一次）。 */
const WINDOW = 200;

/** 一条「大」历史：300 条，前 100 条带可区分的正文，便于按内容比对。 */
function history(n = 300): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ role: "user", content: `用户消息 #${i}` });
    out.push({ role: "assistant", content: `助手回复 #${i}` });
  }
  return out.slice(0, n);
}

interface RestoreMod {
  restoreSessionHistory(pane: unknown, guard?: () => boolean): Promise<void>;
}
interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): { el: unknown };
  activatePane(id: string, kind?: string, title?: string): unknown;
}

/** 记录每次 /messages 请求带的 tail（undefined = 未裁剪）。 */
let askedTails: Array<number | undefined> = [];

/**
 * 装一个**如实**的服务端桩，两种形态都按真实语义实现：
 *
 *   · `honorTail: false` —— **旧后端 / 未裁剪**：不认识 `?tail`（忽略未知查询参数），
 *     一律回全量。这正是生产实例（改动前）在跑的行为，也是版本偏斜时前端会遇到的行为。
 *   · `honorTail: true`  —— **新后端**：`?tail=N` 回最后 N 条，与
 *     apps/studio/src/handlers/sessions.ts 的 tailParam + window 逐字同构。
 *
 * 两条路径跑的是**同一份前端**（ui/restore.ts），所以「渲染一致」比较的就是
 * 「服务端裁 vs 前端裁」这一件事本身。
 */
function stubServer(rows: Array<Record<string, unknown>>, honorTail: boolean): void {
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url);
    if (u.indexOf("/messages") !== -1) {
      const m = /[?&]tail=(\d+)/.exec(u);
      const tail = m ? Number.parseInt(m[1] as string, 10) : undefined;
      askedTails.push(tail);
      const wanted = honorTail ? tail : undefined;
      const messages =
        wanted === undefined || wanted >= rows.length ? rows : rows.slice(rows.length - wanted);
      return { ok: true, status: 200, json: async () => ({ ok: true, session: SESSION, messages }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, questions: [] }) };
  });
}

/** 渲染一次历史，返回该容器里的消息列文本序列。 */
async function renderInto(rows: Array<Record<string, unknown>>, honorTail: boolean): Promise<string[]> {
  doc.body.innerHTML = HTML;
  vi.resetModules();
  stubServer(rows, honorTail);
  const ctx = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as ViewCtxMod;
  ctx.initViewCtx();
  const pane = ctx.ensurePane(SESSION, "session", "甲会话");
  ctx.activatePane(SESSION, "session", "甲会话");
  const restore = (await import(/* @vite-ignore */ at("ui/restore.ts"))) as RestoreMod;
  await restore.restoreSessionHistory(pane);
  await flush();
  const el = pane.el as { querySelectorAll(sel: string): ArrayLike<{ textContent: string | null }> };
  // 归一化：只抹掉渲染时刻（.msg-caption 的 HH:MM:SS）。那是墙钟，两次渲染必然不同秒，
  // 与「渲染了哪些消息」无关；不抹掉会让本用例按秒随机变红（实测踩过一次）。
  const strip = (s: string): string => s.replace(/\d{2}:\d{2}:\d{2}/g, "T").trim();
  return Array.from(el.querySelectorAll(".mcol"), (c) => strip(c.textContent ?? ""));
}

beforeEach(() => { resetHarness(); askedTails = []; });
afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

describe("W2015 · 裁剪路径 vs 全量路径：渲染结果一致", () => {
  it("同一段历史，两条路径渲染出的消息列逐条相同", async () => {
    const rows = history(300);

    // ── 全量路径：旧后端忽略 ?tail，回全部 300 条，前端自己 slice(-200) ──
    const fullCols = await renderInto(rows, false);
    expect(askedTails[0], "前端必须**请求** tail（否则省不下字节）").toBe(WINDOW + 1);

    // ── 裁剪路径：新后端认识 ?tail，只回最后 201 条 ────────────────
    const cutCols = await renderInto(rows, true);
    expect(askedTails[1], "裁剪路径同样带 tail").toBe(WINDOW + 1);

    // ★ 核心判据：两边渲染出的列序列逐条相同。
    expect(cutCols).toEqual(fullCols);
    // 而且不是「都渲染成空」这种假相等。
    expect(fullCols.length, "必须真的渲染出列").toBeGreaterThan(0);
  });

  it("折叠提示仍然正确：长会话显示「仅显示最近 200 条」，短会话不显示", async () => {
    // 长会话（300 条 > 200）⇒ 折叠提示在，且文案里的 n 就是渲染窗口。
    await renderInto(history(300), true);
    const longFold = doc.querySelector(".restore-fold");
    expect(longFold, "长会话必须有折叠提示").not.toBeNull();
    expect(longFold?.textContent ?? "").toContain("200");

    // 短会话（40 条 ≤ 200）⇒ 没有折叠提示（总数就是这么多）。
    const shortCols = await renderInto(history(40), true);
    expect(doc.querySelector(".restore-fold"), "短会话不得出现折叠提示").toBeNull();
    expect(shortCols.length).toBeGreaterThan(0);
  });

  it("边界：正好 200 条 ⇒ 无折叠提示；201 条 ⇒ 有（tail+1 保住这个比特）", async () => {
    // 正好 200：服务端回 200（< 请求的 201）⇒ 总数就是 200 ⇒ 不提示。
    await renderInto(history(200), true);
    expect(doc.querySelector(".restore-fold"), "正好 200 条不该提示折叠").toBeNull();

    // 201：服务端回 201 ⇒ 总数 > 200 ⇒ 提示照出。
    await renderInto(history(201), true);
    expect(doc.querySelector(".restore-fold"), "201 条必须提示折叠").not.toBeNull();
  });
});
