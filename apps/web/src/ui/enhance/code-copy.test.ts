// @vitest-environment jsdom
// ============================================================================
// W895 · P0 验收：第一项可选组件「代码块复制」。
//   · 幂等 —— 流式每节拍重跑，按钮只能加一次；
//   · 包一层 .code-wrap —— pre 自己 overflow-x:auto，按钮放里面会横向滚走；
//   · 可关 —— 注销后不再施加（A3 的组件侧证明）。
//
// W9344 追加两组：① 复制控件改成**图标**之后的可访问性（可访问名/装饰性图标/回显/
//   幂等）；② 工具条右上角的**顺序**（[复制图标] [json]，与增强链先后无关）。
// ============================================================================
import { beforeEach, describe, expect, it } from "vitest";
import { t, setLocale, getLocale } from "../../i18n";
import { CODE_COPY_ID, codeCopyEnhancer } from "./code-copy";
import { codeExtrasEnhancer } from "./code-extras";
import { CODE_HEAD_CLASS } from "./code-chrome";
import { enhancerIds, registerEnhancer, runEnhancers } from "./registry";
import { deactivatePlugin, registerEnhancerPlugin } from "../../plugins/register";
import { PLUGINS_STORAGE_KEY } from "../../plugins/store";

function containerWith(html: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "content";
  box.innerHTML = html;
  document.body.appendChild(box);
  return box;
}

beforeEach(() => {
  localStorage.removeItem(PLUGINS_STORAGE_KEY);
  document.body.innerHTML = "";
});

describe("W895 code-copy component", () => {
  it("adds exactly one button per code block, idempotently", () => {
    const box = containerWith("<pre><code>const a = 1;</code></pre>");
    const off = registerEnhancer(codeCopyEnhancer());
    try {
      runEnhancers(box);
      runEnhancers(box);
      runEnhancers(box);
      expect(box.querySelectorAll("button.code-copy")).toHaveLength(1);
    } finally { off(); }
  });

  it("wraps the pre so the button does not scroll with the code", () => {
    const box = containerWith("<pre><code>x</code></pre>");
    const off = registerEnhancer(codeCopyEnhancer());
    try {
      runEnhancers(box);
      const wrap = box.querySelector(".code-wrap");
      expect(wrap).not.toBeNull();
      // 按钮是 pre 的**兄弟**，不是子节点 —— 否则 overflow-x 会把它带走。
      expect(wrap!.querySelector("pre")).not.toBeNull();
      expect(wrap!.querySelector("button.code-copy")).not.toBeNull();
      expect(box.querySelector("pre button")).toBeNull();
    } finally { off(); }
  });

  it("handles several code blocks independently", () => {
    const box = containerWith("<pre><code>a</code></pre><p>text</p><pre><code>b</code></pre>");
    const off = registerEnhancer(codeCopyEnhancer());
    try {
      runEnhancers(box);
      expect(box.querySelectorAll("button.code-copy")).toHaveLength(2);
    } finally { off(); }
  });

  it("leaves a container with no code block untouched", () => {
    const box = containerWith("<p>just text</p>");
    const off = registerEnhancer(codeCopyEnhancer());
    try {
      runEnhancers(box);
      expect(box.querySelectorAll("button")).toHaveLength(0);
      expect(box.querySelectorAll(".code-wrap")).toHaveLength(0);
    } finally { off(); }
  });

  it("A3: turning the component off really unregisters it", () => {
    registerEnhancerPlugin(codeCopyEnhancer());
    expect(enhancerIds()).toContain(CODE_COPY_ID);
    deactivatePlugin(CODE_COPY_ID);
    expect(enhancerIds()).not.toContain(CODE_COPY_ID);
    // 关掉之后，新容器不再被施加该增强。
    const box = containerWith("<pre><code>x</code></pre>");
    runEnhancers(box);
    expect(box.querySelectorAll("button.code-copy")).toHaveLength(0);
  });
});

/**
 * W9344：改成复制**图标**之后的可访问性硬约束。
 *
 * 判据是**后果**不是机制：产品坏了是什么样？—— 变成一枚没名字的图标，
 * 读屏念不出「复制」，键盘用户不知道按下去会发生什么。所以守两件事：
 *   ① 有可访问名（且走 i18n 那一套，不是硬编码英文字面量）；
 *   ② 图标本身是装饰性的（名字由按钮承载，图标不该被重复播报）。
 * 焦点环与键盘可达由真机探针量（jsdom 没有排版与 :focus-visible），见
 * scripts/a11y/w9344-codehead-probe.mjs。
 */
describe("W9344 复制图标的可访问性", () => {
  function withButton(html: string): HTMLButtonElement {
    const box = containerWith(html);
    const off = registerEnhancer(codeCopyEnhancer());
    try {
      runEnhancers(box);
      const btn = box.querySelector<HTMLButtonElement>("button.code-copy")!;
      return btn;
    } finally { off(); }
  }

  it("按钮是可访问名非空的原生 button（图标化最容易丢的就是这一条）", () => {
    const btn = withButton("<pre><code>x</code></pre>");
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("type")).toBe("button");
    const name = btn.getAttribute("aria-label");
    expect(name, "图标按钮必须显式给 aria-label").toBeTruthy();
    // 名字必须来自 i18n 那一套（与现在 chat.codeCopy.copy 同一个键）。
    expect(name).toBe(t("chat.codeCopy.copy"));
    expect(name).not.toBe("Copy"); // 硬编码英文字面量 ⇒ 换语言时名字不变
  });

  it("title 也给同一个 i18n 名字（鼠标用户与老 AT 的回落路径）", () => {
    const btn = withButton("<pre><code>x</code></pre>");
    expect(btn.title).toBe(t("chat.codeCopy.copyHint"));
  });

  it("图标本身是装饰性的（aria-hidden）—— 名字只有一个来源，不重复播报", () => {
    const btn = withButton("<pre><code>x</code></pre>");
    const svg = btn.querySelector("svg");
    expect(svg, "必须有图标").not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
    // 按钮的可访问名不能被图标文本污染（图标没有文本，但这条守住「不塞 textContent」）。
    expect(btn.textContent).toBe("");
  });

  it("可访问名在语言切换后随之改变（真的走了 i18n，不是快照）", () => {
    const prev = getLocale();
    setLocale("zh");
    const btn = withButton("<pre><code>x</code></pre>");
    const zh = btn.getAttribute("aria-label");
    setLocale("en");
    try {
      const box = containerWith("<pre><code>y</code></pre>");
      const off = registerEnhancer(codeCopyEnhancer());
      try {
        runEnhancers(box);
        const en = box.querySelector("button.code-copy")!.getAttribute("aria-label");
        expect(en).toBe(t("chat.codeCopy.copy"));
        expect(en, "中英必须不同，否则说明没走 i18n").not.toBe(zh);
      } finally { off(); }
    } finally { setLocale(prev); }
  });

  it("点击后回显可达：aria-label 带上结果，且有 role=status 的视觉回显", async () => {
    const box = containerWith("<pre><code>hello</code></pre>");
    const off = registerEnhancer(codeCopyEnhancer());
    try {
      runEnhancers(box);
      const btn = box.querySelector<HTMLButtonElement>("button.code-copy")!;
      // jsdom 没有 clipboard API ⇒ writeClipboard 走 execCommand 回退并如实返回
      // false（两条都失败就报失败，绝不假装成功）。断言只关心「回显这条路通」，
      // 不关心回的是成功还是失败。
      btn.click();
      await Promise.resolve();
      await Promise.resolve();
      const note = box.querySelector(".code-copy-note");
      expect(note, "图标按钮没有可见文字可换 ⇒ 回显另有一处").not.toBeNull();
      expect(note!.getAttribute("role")).toBe("status");
      // 名字里带上了结果（成功或失败之一），且不再只是「复制」二字。
      const name = btn.getAttribute("aria-label")!;
      expect(name).not.toBe(t("chat.codeCopy.copy"));
      expect(
        name.includes(t("chat.codeCopy.copied")) || name.includes(t("chat.codeCopy.failed")),
        `名字里应带结果，实际=「${name}」`,
      ).toBe(true);
    } finally { off(); }
  });

  it("流式每节拍重跑增强链：按钮/图标/回显节点都不重复建（幂等）", () => {
    const box = containerWith("<pre><code class='language-json'>{}</code></pre>");
    const off = registerEnhancer(codeCopyEnhancer());
    try {
      for (let i = 0; i < 4; i += 1) runEnhancers(box);
      expect(box.querySelectorAll("button.code-copy")).toHaveLength(1);
      expect(box.querySelectorAll("button.code-copy > svg")).toHaveLength(1);
    } finally { off(); }
  });
});

/**
 * W9344：工具条右上角的**顺序** = [复制图标] [json]。
 *
 * 守的是**后果**（读屏与视觉用户都按这个顺序读到「先操作、后标签」，
 * 且和 GitHub 等惯例一致），具体由哪条 CSS 或哪次 insertBefore 达成不钉。
 */
describe("W9344 工具条顺序：复制在左、徽标在右", () => {
  it("文档序是 [复制] [徽标]（code-copy 先建、code-extras 后插）", () => {
    const box = containerWith("<pre><code class='language-json'>{}</code></pre>");
    const offCopy = registerEnhancer(codeCopyEnhancer());
    const offExtras = registerEnhancer(codeExtrasEnhancer());
    try {
      runEnhancers(box);
      const head = box.querySelector("." + CODE_HEAD_CLASS)!;
      const kids = Array.from(head.children).map((c) => c.className);
      const iCopy = kids.findIndex((c) => c.includes("code-copy"));
      const iBadge = kids.findIndex((c) => c.includes("code-badge"));
      expect(iCopy).toBeGreaterThanOrEqual(0);
      expect(iBadge).toBeGreaterThanOrEqual(0);
      expect(iCopy, "复制图标必须在徽标左边").toBeLessThan(iBadge);
    } finally { offCopy(); offExtras(); }
  });

  it("反过来先跑 code-extras，顺序仍然不变（增强链顺序不可影响结果）", () => {
    const box = containerWith("<pre><code class='language-json'>{}</code></pre>");
    const offExtras = registerEnhancer(codeExtrasEnhancer());
    try {
      runEnhancers(box);
      const offCopy = registerEnhancer(codeCopyEnhancer());
      try {
        runEnhancers(box);
        const head = box.querySelector("." + CODE_HEAD_CLASS)!;
        const kids = Array.from(head.children).map((c) => c.className);
        const iCopy = kids.findIndex((c) => c.includes("code-copy"));
        const iBadge = kids.findIndex((c) => c.includes("code-badge"));
        expect(iCopy).toBeLessThan(iBadge);
      } finally { offCopy(); }
    } finally { offExtras(); }
  });
});
