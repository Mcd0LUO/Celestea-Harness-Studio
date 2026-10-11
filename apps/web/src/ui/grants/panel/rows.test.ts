// ============================================================================
// M2-B2a · desktop 行的录入 UI 与已授予摘要（DOM 行为，加载真实模块）。
//
// 为什么必须有这一层：apps.ts 的单测钉的是「文本 → scope」的形状，但**用户真正
// 看得见的那四个框**是 rows.ts 建的 —— 框少了、标签贴错侧、草稿重绘丢字、授予后
// 摘要不说清单，这些都不会让 apps.ts 的单测变红。这里把行真的渲染出来断言结构。
//
// 像素级几何（真的可见、不裁切）由真机走查覆盖；jsdom 无排版，这里只钉结构与文案。
// ============================================================================
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { renderRow } from "./rows";
import { capByName, type CapDef } from "../caps";
import {
  appsDraftKey,
  drafts,
  inlineError,
  setData,
  setShieldBadge,
  setShieldButton,
  type GrantsHost,
} from "../state";
import { renderShield } from "./shield";
import { emptyAppsDraft } from "../apps";
import { confirmMessageFor } from "../copy";
import { phraseFor } from "./phrase";
import { setLocale } from "../../../i18n";
import type { GrantsResp } from "../../../types";

setLocale("zh");

/** 宿主桩：这里只渲染，不触发授予/撤销。 */
const host: GrantsHost = {
  refresh: async () => undefined,
  focusedSession: () => "s1",
  renderPanel: () => undefined,
  startGrant: async () => undefined,
  revoke: async () => undefined,
};

function desktopDef(): CapDef {
  const def = capByName().get("desktop");
  if (!def) throw new Error("caps() 里没有 desktop");
  return def;
}

function snapshot(grants: GrantsResp["grants"]): GrantsResp {
  return { ok: true, session: "s1", grants, effective: {}, max_ttl_sec: {} };
}

beforeEach(() => {
  drafts.clear();
  inlineError.clear();
  setData(null, "");
});

describe("M2-B2a desktop 行：未授予时的四个录入框", () => {
  it("caps() 里 desktop 已是 kind:'apps' 且仍是危险能力", () => {
    const def = desktopDef();
    expect(def.kind).toBe("apps");
    expect(def.danger).toBe(true);
  });

  it("渲染出四个文本框：allow/deny × 程序/窗口标题", () => {
    const row = renderRow(desktopDef(), host);
    const inputs = Array.from(row.querySelectorAll<HTMLInputElement>("input.grant-input"));
    expect(inputs).toHaveLength(4);
    const text = row.textContent ?? "";
    // 四个框各有一个标签；两侧各有一句说明。
    expect(text).toContain("只允许这些");
    expect(text).toContain("始终排除这些");
    expect(text).toContain("程序（exe 文件名或完整路径）");
    expect(text).toContain("窗口标题");
  });

  it("**空 allow = 不限制**的语义写在界面上（不是「什么都不允许」）", () => {
    const row = renderRow(desktopDef(), host);
    expect(row.textContent ?? "").toContain("留空 = 不限制");
    // deny 的优先级也必须在界面上说清。
    expect(row.textContent ?? "").toContain("排除永远优先");
  });

  it("草稿回填：重绘不丢字", () => {
    drafts.set(appsDraftKey("desktop"), JSON.stringify({ ...emptyAppsDraft(), allowExes: "notepad.exe" }));
    const row = renderRow(desktopDef(), host);
    const values = Array.from(row.querySelectorAll<HTMLInputElement>("input.grant-input")).map((i) => i.value);
    expect(values).toContain("notepad.exe");
  });

  it("输入即写草稿（下一次重绘读得到）", () => {
    const row = renderRow(desktopDef(), host);
    const first = row.querySelector<HTMLInputElement>("input.grant-input");
    expect(first).not.toBeNull();
    if (!first) return;
    first.value = "cmd.exe";
    first.dispatchEvent(new Event("input"));
    expect(drafts.get(appsDraftKey("desktop"))).toContain("cmd.exe");
  });
});

describe("M2-B2a 确认句与预览句：空 allow 必须说成「不限制」", () => {
  it("空清单的确认句说「不限制」，不是「什么都不允许」", () => {
    const msg = confirmMessageFor(desktopDef(), {}, null);
    expect(msg).toContain("不限制");
    // 永久条目（expiresAt=null）走「撤销前一直有效」，不出现具体时刻（W773 口径）。
    expect(msg).toContain("撤销前一直有效");
    expect(msg).not.toContain("0 个");
  });

  it("带清单的确认句把 allow/deny 的口径填进去", () => {
    const msg = confirmMessageFor(
      desktopDef(),
      { apps: { allow: { exes: ["notepad.exe"] }, deny: { exes: ["cmd.exe"] } } },
      null,
    );
    expect(msg).toContain("只允许操作");
    expect(msg).toContain("1 个程序");
    expect(msg).toContain("始终排除");
  });

  it("结果预览句：无清单时逐字沿用旧文案，有清单时补上口径", () => {
    expect(phraseFor(desktopDef(), {})).toBe("操作这台电脑的桌面");
    const scoped = phraseFor(desktopDef(), { apps: { allow: { exes: ["a.exe"] } } });
    expect(scoped).toContain("操作这台电脑的桌面");
    expect(scoped).toContain("只允许操作");
  });
});

describe("M2-B2a 盾牌三态不被 apps 行影响", () => {
  /**
   * 盾牌三态读的是 `activeGrants()`（模块级生效集），apps 只改了**行内**的录入框与
   * 摘要文案。这里用注入的盾牌 DOM 把这条关系钉住：三态的输入源没有因为 desktop
   * 升级成 apps 而改变。
   */
  function shieldDom(): { btn: HTMLButtonElement; badge: HTMLElement } {
    document.body.innerHTML = "";
    const btn = document.createElement("button");
    const badge = document.createElement("span");
    document.body.append(btn, badge);
    setShieldButton(btn);
    setShieldBadge(badge);
    return { btn, badge };
  }

  it("没有放宽项 ⇒ 盾牌未授予态（无角标、无 granted 类）", () => {
    setData(snapshot([]), "s1");
    const { btn, badge } = shieldDom();
    renderShield();
    expect(btn.classList.contains("granted")).toBe(false);
    expect(badge.textContent).toBe("");
  });

  it("desktop（apps 形状）已生效 ⇒ 盾牌计数 1、granted 类（与行的渲染无关）", () => {
    setData(
      snapshot([
        { id: "g-9", cap: "desktop", scope: { apps: { allow: { exes: ["a.exe"] } } }, expires_at: null },
      ]),
      "s1",
    );
    const { btn, badge } = shieldDom();
    renderShield();
    expect(btn.classList.contains("granted")).toBe(true);
    expect(badge.textContent).toBe("1");
    expect(btn.title).toContain("1");
  });
});

describe("M2-B2a desktop 行：已授予时的清单摘要", () => {
  it("显示 exe 数 / title 数，且不再出现录入框", () => {
    setData(
      snapshot([
        {
          id: "g-1",
          cap: "desktop",
          scope: { apps: { allow: { exes: ["a.exe", "b.exe"], titles: ["t1"] }, deny: { exes: ["cmd.exe"] } } },
          expires_at: null,
        },
      ]),
      "s1",
    );
    const row = renderRow(desktopDef(), host);
    expect(row.querySelectorAll("input.grant-input")).toHaveLength(0);
    const detail = row.querySelector(".grant-detail")?.textContent ?? "";
    expect(detail).toContain("2");
    expect(detail).toContain("1");
    // 三态判定看的是生效集：已授予 ⇒ 出现撤销按钮，没有授予按钮。
    const buttons = Array.from(row.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(buttons).toContain("撤销");
    expect(buttons).not.toContain("授予");
  });

  it("没有清单的存量授权（升级前的 bool 形状）显示「不限应用」，不是空白", () => {
    setData(snapshot([{ id: "g-2", cap: "desktop", scope: {}, expires_at: null }]), "s1");
    const row = renderRow(desktopDef(), host);
    expect(row.querySelector(".grant-detail")?.textContent ?? "").toContain("不限应用");
  });

  it("未授予时不显示清单摘要，且授予按钮照旧", () => {
    setData(snapshot([]), "s1");
    const row = renderRow(desktopDef(), host);
    expect(row.querySelector(".grant-detail")).toBeNull();
    const buttons = Array.from(row.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(buttons).toContain("授予");
  });
});
