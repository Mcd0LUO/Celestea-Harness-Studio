// ============================================================================
// ui/enhance/code-copy.ts — 代码块「复制」按钮（W895 · P0 的第一项可选组件）
// ----------------------------------------------------------------------------
// 为什么是它当 P0：代码块本来连复制按钮都没有（全仓 grep 为空），而它同时验证了
// 增强缝最难的两点 ——
//   1) **幂等**：流式每个节拍重跑整条链，靠 pre.dataset.copyDone 保证按钮只加一次；
//   2) **节点被替换后仍然正确**：尾部节点每节拍重建，新节点会重新拿到按钮，
//      旧节点连同它的监听器一起被丢弃（不留悬挂监听）。
//
// 剪贴板：优先 navigator.clipboard（安全上下文）；不可用时回退 execCommand ——
// 服务端可能经隧道以 http 暴露在非 localhost 主机上，那时 clipboard API 不存在。
// 两条都失败就如实显示「复制失败」，绝不假装成功。
//
// W1526（代码块优化）：按钮从**绝对定位浮层**（top:6px/right:6px，压在首行正文上）
// 改为住进 `.code-head` 工具条（见 code-chrome.ts）—— 工具条在 `.code-wrap` 里、
// `pre` 上面，是正常流里的一行。浮层改占位是「装饰与正文永不重叠」的实现方式，
// 详见 styles/codeblock.css。
//
// W9344（代码块工具条）：控件从**文字「复制」改成复制图标**（几何真源 ui/icons.ts），
// 排在语言徽标的**左侧**（右上角顺序 = [复制图标] [json]）。可访问性**一个字没丢**：
//   · 可访问名走 aria-label / title，仍是 `chat.codeCopy.copy` 那一套 i18n；
//   · 图标自身 `aria-hidden`（它的名字由按钮承载，重复播报反而是噪声）；
//   · 按钮仍是原生 <button> ⇒ 键盘可达、`:focus-visible` 由 .btn 基底的
//     `outline: 2px solid var(--c-focus-ring)` 画出来（components.css 的既有口径）。
//   · 回显（已复制/复制失败）走**无障碍播报**（aria-live 的 .code-copy-note）而不是塞进
//     图标按钮里：图标按钮没有可见文字可换，而「点了有回显」是这条控件既有的行为承诺，
//     不能丢。按钮的 aria-label 同步成当前状态，焦点停在它上面时也读得出结果。
// ============================================================================
import { t } from "../../i18n";
import { iconNode } from "../icons";
import { ensureHead } from "./code-chrome";
import type { Enhancer } from "./registry";

/** 登记表 / 设置页 / 测试共用的身份。 */
export const CODE_COPY_ID = "display.codeCopy";

/** 复制后的回显时长（ms）。 */
const FEEDBACK_MS = 1200;

/** 一个「给每个代码块加复制按钮」的增强遍（工厂：幂等，可反复调用）。 */
export function codeCopyEnhancer(): Enhancer {
  return { id: CODE_COPY_ID, enhance: addCopyButtons };
}

/** 幂等：已加过按钮的 pre 直接跳过（同一个容器会被反复传入）。 */
function addCopyButtons(container: Element): void {
  for (const pre of Array.from(container.querySelectorAll<HTMLElement>("pre"))) {
    if (pre.dataset["copyDone"] === "1") continue;
    pre.dataset["copyDone"] = "1";
    // 包一层 .code-wrap：pre 自己 overflow-x:auto，按钮若直接放进 pre 里会随内容横向滚走。
    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    pre.parentNode?.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    const btn = document.createElement("button");
    btn.type = "button";
    // 复用既有 .btn 基底（外观与其它按钮一致），只额外定位。
    btn.className = "btn code-copy";
    // W9344：图标按钮没有可见文字 ⇒ **可访问名必须显式给**（走同一套 i18n）。
    // title 同时给（鼠标用户悬停看得到，且老 AT 会回落读它）。
    btn.setAttribute("aria-label", t("chat.codeCopy.copy"));
    btn.title = t("chat.codeCopy.copyHint");
    btn.appendChild(iconNode("copy", { className: "code-copy-ico" }));
    btn.addEventListener("click", () => {
      void copyBlock(pre, btn);
    });
    // W1526：按钮住进工具条（正常流，占位）—— 浮层会压在首行正文上。
    // 工具条由 code-copy / code-extras 共用（谁先跑谁建）。
    // 仍在 .code-wrap 里、**不在 pre 内**：长行横向滚动时按钮不会被滚走
    // （上面「按钮是 pre 的兄弟」那条断言守的正是这个归属）。
    ensureHead(wrap).appendChild(btn);
  }
}

/**
 * 回显：图标按钮的**可访问名**与状态一起改，并挂一个 `aria-live` 的视觉提示。
 *
 * 为什么不用 visible text 换字（改动前的做法）：按钮现在只有一枚图标，
 * 把「已复制 / 复制失败」写进去要么把图标顶掉、要么造出第二个焦点目标。
 * ⇒ 文案进独立的 `.code-copy-note`（role=status，视觉上紧挨按钮、1.2s 后自行消失），
 * 读屏与视觉用户拿到的是同一句话；按钮的 aria-label 同步成当前状态，
 * 让「这个控件现在是什么状态」在焦点停在它上面时也读得出来。
 */
async function copyBlock(pre: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  const code = pre.querySelector("code");
  const text = code?.textContent ?? "";
  const ok = await writeClipboard(text);
  const state = ok ? t("chat.codeCopy.copied") : t("chat.codeCopy.failed");
  btn.setAttribute("aria-label", t("chat.codeCopy.copy") + "：" + state);
  const note = noteOf(btn);
  note.textContent = state;
  note.classList.toggle("is-err", !ok);
  window.setTimeout(() => {
    note.textContent = "";
    // 名字回到常态，否则复述按钮时会读到上一次的结果。
    if (btn.isConnected) btn.setAttribute("aria-label", t("chat.codeCopy.copy"));
  }, FEEDBACK_MS);
}

/** 按钮旁的回显节点（懒建一次，跨次复用 —— 流式重跑增强链不许每次造新节点）。 */
function noteOf(btn: HTMLButtonElement): HTMLElement {
  const head = btn.parentElement;
  let note = head?.querySelector<HTMLElement>(".code-copy-note") ?? null;
  if (note === null || head === null) {
    note = document.createElement("span");
    note.className = "code-copy-note";
    note.setAttribute("role", "status");
    head?.insertBefore(note, btn.nextSibling);
  }
  return note;
}

/** 写剪贴板：现代 API 优先，失败回退 execCommand；都失败返回 false。 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined && navigator.clipboard !== null) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 安全上下文外 / 权限被拒：继续走回退路径，不把失败当成功。
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
