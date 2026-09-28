// @vitest-environment jsdom
/**
 * W2059 · 切换模型后的**显示来源**（真实模块 + 真实 DOM 事件，jsdom）。
 *
 * 用户报案：「切换模型有个回归bug，切换了新的模型，显示的还是 deepseek，
 * 推理档位也不正确」。
 *
 * 三条把**全局值**当**会话值**的路径（本文件逐条钉住）：
 *   ① /api/health 的 model 是全局默认（handlers/health.ts 读 runtime.profile()），
 *      切换成功后 main.ts 的 studio:config-saved 监听把它 merge 进状态栏 ⇒ 会话模型
 *      被打回 deepseek，直到下一次 2s 轮询才纠正；
 *   ② 弹层高亮：picker-list 的 `cfg.model ?? host.snapshotModel` 的 ?? 右支永不
 *      触发（cfg.model 永远非空）⇒ 带覆盖的会话高亮的是全局默认；
 *   ③ 切**档位**时 picker.apply 用 POST /api/config 的响应 d.model（全局回声）
 *      覆盖会话模型 ⇒ 只动档位也把模型显示打错。
 *
 * 回落方向也必须保留：**无聚焦会话**（旧单会话容器）时全局就是会话真值。
 *
 * 加载范式沿用 tests/w870-session-model-picker-dom.test.ts。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface El {
  textContent: string | null;
  innerHTML: string;
  value: string;
  title: string;
  isConnected: boolean;
  classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): boolean; contains(c: string): boolean };
  appendChild(n: El): El;
  replaceChildren(...n: El[]): void;
  remove(): void;
  setAttribute(k: string, v: string): void;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  dispatchEvent(e: unknown): boolean;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): Iterable<El>;
}
interface Doc {
  body: El;
  createElement(tag: string): El;
  getElementById(id: string): El | null;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): Iterable<El>;
}
interface SlMod {
  statusline: {
    setSession(id: string): void;
    merge(p: Record<string, unknown>): void;
    setModel(m: string): void;
    stop(): void;
  };
}

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web", "src");
const at = (rel: string): string => pathToFileURL(join(SRC, rel)).href;

const i18n = (await import(/* @vite-ignore */ at("i18n/index.ts"))) as { setLocale(l: string): void };
i18n.setLocale("zh");

const doc = (globalThis as unknown as { document: Doc }).document;
const Ev = (globalThis as unknown as { Event: new (t: string, i?: { bubbles?: boolean }) => unknown }).Event;
/** jsdom 的 window（本文件用它的 addEventListener/dispatchEvent，与 main.ts 同一入口）。 */
const win = globalThis as unknown as {
  addEventListener(t: string, f: () => void): void;
  dispatchEvent(e: unknown): boolean;
};

/** 与 index.html 的 id/class 一致的最小骨架。 */
const HTML =
  '<div id="messages"></div>' +
  '<div id="statusline" class="statusline">' +
  '<span class="sl-ring"><svg viewBox="0 0 14 14"><circle class="sl-ring-track"></circle>' +
  '<circle class="sl-ring-prog"></circle></svg></span>' +
  '<span class="sl-ctx" id="slCtx">—/—</span>' +
  '<button class="sl-model" id="slModel">—</button>' +
  '<button class="sl-effort" id="slEffort">—</button>' +
  '<button class="sl-mode hidden" id="slMode"></button>' +
  '<span class="sl-tps" id="slTps"></span><span class="sl-cache" id="slCache"></span>' +
  '<span class="sl-steps" id="slSteps"></span><span class="sl-hint" id="slHint"></span>' +
  "</div>";

/** 夹具：全局默认 m-global，聚焦会话自带覆盖 m-session（config ≠ status）。 */
const GLOBAL_MODEL = "m-global";
const SESSION_MODEL = "m-session";
const PICKED = "m-picked";

let sl: SlMod;
let calls: { url: string; method: string; body: string }[];
let healthModel: string;
let configEffort: string | null;
let sessionEffort: string | null;
let sessionModelStatus: number;

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
const click = (n: El | null): void => void n?.dispatchEvent(new Ev("click"));
const badge = (): El => doc.getElementById("slModel") as El;
const effortBadge = (): El => doc.getElementById("slEffort") as El;
const opts = (): El[] => [...doc.querySelectorAll("#statusline .sl-opt")];
const currentVals = (): string[] =>
  opts().filter((b) => b.classList.contains("current")).map((b) => b.querySelector(".sl-opt-val")?.textContent ?? "");

const reply = (status: number, payload: unknown): unknown => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

/** main.ts refreshHealthChip 的**唯一一行**模型写入（这里原样复刻以便端到端断言）。 */
function wireHealthChip(): void {
  win.addEventListener("studio:config-saved", () => {
    void fetch("/api/health")
      .then((r) => r.json() as Promise<{ model?: string }>)
      .then((h) => {
        if (h.model) sl.statusline.merge({ model: h.model });
      });
  });
}

beforeEach(async () => {
  calls = [];
  healthModel = GLOBAL_MODEL;
  configEffort = "low";
  sessionEffort = "max";
  sessionModelStatus = 200;
  doc.body.innerHTML = HTML;
  vi.stubGlobal("fetch", async (url: unknown, init?: { body?: unknown; method?: string }) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body === undefined ? "" : String(init.body);
    calls.push({ url: u, method, body });
    if (u.startsWith("/api/health")) return reply(200, { ok: true, model: healthModel, capabilities: {} });
    if (u.startsWith("/api/status")) {
      return reply(200, {
        ok: true,
        model: SESSION_MODEL,
        reasoning_effort: sessionEffort,
        mode: "standard",
        model_covered: true,
      });
    }
    if (/\/api\/sessions\/.+\/model$/.test(u)) {
      if (sessionModelStatus !== 200) return reply(sessionModelStatus, { ok: false, error: "nope" });
      const asked = (JSON.parse(body === "" ? "{}" : body) as { model?: string }).model ?? "";
      return reply(200, { ok: true, session: "ws/s1", model: asked, covered: true, effective: { model: asked } });
    }
    if (u.startsWith("/api/config")) {
      const asked = (JSON.parse(body === "" ? "{}" : body) as { model?: string }).model ?? "";
      return reply(200, {
        ok: true,
        model: asked !== "" ? asked : GLOBAL_MODEL,
        reasoning_effort: configEffort,
        available: {
          models: [
            // 后端按**全局** profile 标 active ⇒ 它标的是 m-global（缺陷 2 的陷阱）。
            { id: GLOBAL_MODEL, name: "Global", provider_id: "p1", provider: "P1", active: true },
            { id: SESSION_MODEL, name: "Session", provider_id: "p1", provider: "P1" },
            { id: PICKED, name: "Picked", provider_id: "p1", provider: "P1" },
          ],
        },
      });
    }
    return reply(404, { ok: false });
  });
  vi.resetModules();
  sl = (await import(/* @vite-ignore */ at("statusline.ts"))) as SlMod;
  sl.statusline.setSession("ws/s1");
  await tick();
});

afterEach(() => {
  sl?.statusline.stop();
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

async function openModelPopup(): Promise<void> {
  click(badge());
  await tick();
}

describe("W2059 ① · studio:config-saved 不得用 health 的全局默认覆盖会话模型", () => {
  it("切换后派发 config-saved（health 回全局默认）：徽标仍是会话模型", async () => {
    wireHealthChip();
    await openModelPopup();
    const row = opts().find((b) => (b.querySelector(".sl-opt-val")?.textContent ?? "") === PICKED);
    expect(row, "清单里必须有 m-picked 一行").toBeTruthy();
    click(row ?? null);
    expect(badge().textContent, "W795 乐观：当帧就是新模型").toBe(PICKED);
    await tick();
    expect(badge().textContent).toBe(PICKED);
    // 切换成功后 picker 自己会派发该事件 —— 这里再补一次，模拟设置页保存等其它来源。
    win.dispatchEvent(new Ev("studio:config-saved"));
    await tick();
    expect(badge().textContent, "health 的全局默认不得覆盖会话模型").toBe(PICKED);
  });

  it("merge 的 model 只兜底：会话快照已有非空 model 时一律不覆盖", () => {
    sl.statusline.setModel(SESSION_MODEL);
    sl.statusline.merge({ model: GLOBAL_MODEL });
    expect(badge().textContent).toBe(SESSION_MODEL);
    // 兜底方向仍在：快照里**没有** model 时，merge 填上它。
    sl.statusline.merge({ model: "" });
    sl.statusline.merge({ model: GLOBAL_MODEL });
    expect(badge().textContent).toBe(SESSION_MODEL);
  });
});

describe("W2059 ② · 弹层高亮按会话真值（config ≠ status 夹具）", () => {
  it("有聚焦会话：高亮 m-session（不是全局 m-global，也不信后端 active）", async () => {
    await openModelPopup();
    expect(currentVals(), "恰好一项高亮，且是会话真值").toEqual([SESSION_MODEL]);
    const globalRow = opts().find((b) => (b.querySelector(".sl-opt-val")?.textContent ?? "") === GLOBAL_MODEL);
    expect(globalRow?.classList.contains("current"), "全局默认不得高亮").toBe(false);
  });

  it("有聚焦会话：档位高亮取状态栏已上报的档位（会话看到的），非全局配置", async () => {
    click(effortBadge());
    await tick();
    expect(effortBadge().textContent).toBe("max");
    const cur = opts().filter((b) => b.classList.contains("current"));
    expect(cur.length, "恰好一项档位高亮").toBe(1);
    expect(cur[0]?.querySelector(".sl-opt-val")?.textContent).toBe("max");
  });

  it("无聚焦会话（旧单会话容器）：回落全局 —— 高亮 m-global", async () => {
    sl.statusline.stop();
    doc.body.innerHTML = HTML;
    vi.resetModules();
    sl = (await import(/* @vite-ignore */ at("statusline.ts"))) as SlMod;
    // 不调 setSession：sessionId 保持 ''（= 旧单会话容器）
    await tick();
    await openModelPopup();
    expect(currentVals(), "无聚焦会话时全局即真值").toEqual([GLOBAL_MODEL]);
  });
});

describe("W2059 ③b · 编排层：apply() 只回声档位，绝不把 config 回声写进模型", () => {
  /**
   * 为什么还要一层编排断言：DOM 断言里 statusline.merge 的 model 守卫会**掩盖**
   * picker.apply 里 `merge({ model: d.model })` 的缺陷（两道防线互为兜底，单看
   * 徽标分不出来 —— 变异 M4 因此不红）。这里用一个记账用的假宿主直接调 apply()，
   * 钉住「哪些字段被写了」：这条在把 d.model 写回去时立刻变红。
   */
  interface ApplyMod { apply(host: Record<string, unknown>, patch: Record<string, unknown>): Promise<void>; }
  const fakeHost = (): Record<string, unknown> => {
    const written: { op: string; value: unknown }[] = [];
    const popup = doc.createElement("div") as unknown as El;
    return {
      written,
      popup,
      popupKind: "effort",
      popupOverlay: null,
      pendingPatch: null,
      pendingPick: null,
      sessionId: "ws/s1",
      snapshotModel: SESSION_MODEL,
      snapshotEffort: "max",
      setModel: (m: string) => written.push({ op: "setModel", value: m }),
      merge: (p: Record<string, unknown>) => written.push({ op: "merge", value: p }),
      setNote: () => undefined,
    };
  };

  it("成功回声里只有 reasoning_effort —— model 一个字节都不写", async () => {
    const picker = (await import(/* @vite-ignore */ at("statusline/picker.ts"))) as unknown as ApplyMod;
    const host = fakeHost();
    await picker.apply(host, { reasoning_effort: "low" });
    const written = host["written"] as { op: string; value: unknown }[];
    // 乐观帧：只画档位（补丁里没有 model）。
    expect(written[0]).toEqual({ op: "merge", value: { reasoning_effort: "low" } });
    // 成功回声：**不得**出现任何带 model 的写入（d.model 是全局回声）。
    const modelWrites = written.filter(
      (w) => w.op === "setModel" || (w.op === "merge" && (w.value as Record<string, unknown>)["model"] !== undefined),
    );
    expect(modelWrites, "切档位不得写 model（d.model 是全局回声）").toEqual([]);
    expect(written[written.length - 1]).toEqual({ op: "merge", value: { reasoning_effort: configEffort } });
  });
});

describe("W2059 ③ · 切档位不得用 /api/config 的全局回声覆盖会话模型", () => {
  it("点档位 low：请求只带 reasoning_effort，且徽标模型保持会话真值", async () => {
    click(effortBadge());
    await tick();
    const lowRow = opts().find((b) => (b.querySelector(".sl-opt-val")?.textContent ?? "") === "low");
    expect(lowRow, "档位清单里必须有 low").toBeTruthy();
    click(lowRow ?? null);
    await tick();
    const posts = calls.filter((c) => c.method === "POST" && c.url === "/api/config");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]?.body ?? "{}"), "档位补丁不得夹带 model").toEqual({ reasoning_effort: "low" });
    expect(badge().textContent, "只切档位时模型不得被打回全局").toBe(SESSION_MODEL);
    expect(effortBadge().textContent).toBe("low");
  });

  it("切档位失败：档位回滚，会话模型仍不被全局值污染", async () => {
    sessionModelStatus = 500;
    click(effortBadge());
    await tick();
    const lowRow = opts().find((b) => (b.querySelector(".sl-opt-val")?.textContent ?? "") === "low");
    click(lowRow ?? null);
    await tick();
    expect(badge().textContent).toBe(SESSION_MODEL);
  });
});
