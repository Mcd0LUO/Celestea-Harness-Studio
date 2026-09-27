// ============================================================================
// scripts/a11y/lib/touch-targets.mjs — WCAG 2.5.8 (AA) 触摸目标审计的**共享内核**
// ----------------------------------------------------------------------------
// 为什么单独成模块：CLI（scripts/a11y/audit-touch-targets.mjs）与门禁
// （tests/w2024-touch-targets.test.ts）必须量**同一件事**。判定写在两处 = 两处会
// 漂移，而「门禁绿了但脚本红了」正是这类审计最坏的失败形态。
//
// ★★ 核心口径（W2024）：
//   SC 2.5.8 的正文不是「一律 >= 24」，而是 ——
//     "The size of the target for pointer inputs is at least 24 by 24 CSS pixels,
//      **except when**: Spacing / Equivalent / Inline / User Agent Control / Essential"
//   Spacing 例外：把直径 24px 的圆**居中放在每个 undersized 目标的包围盒上**，
//   该圆不得与「另一个目标」或「另一个 undersized 目标的圆」相交。
//
//   ⇒ **只报「尺寸 < 24」的脚本会制造假警报**：一个 143x20 的搜索框四周全是空白，
//     它满足 Spacing 例外，**不构成违规**。本仓最忌讳假警报，故审计必须同时给出
//     「尺寸」与「是否满足 Spacing 例外」两个判据，并把最终结论落在
//     `violation` 上 —— 那才是需要人动手的东西。
//
// ★★ 第二个假警报源：**遮挡（occlusion）**。Spacing 例外问的是「目标挨得够不够开」，
//   不是「一个被浮层盖住的控件与浮层上的按钮在几何上重叠」。抽屉拉开时它盖住消息区、
//   设置页盖住顶栏 —— 此时下层控件的矩形仍参与距离计算，就会凭空造出「圆相交」。
//   实测：抽屉 + 设置页叠着时脚本报 5 个「违规」，逐个查证**全是遮挡造成的**。
//   故审计先判**可达性**（在视口内 ∧ 中心点未被别的元素盖住），Spacing 只在可达
//   目标之间计算。被盖住的目标仍会被列出，但带 `occluded` / `offscreen` 标记，
//   且不参与判定 —— 它们在当前呈现状态下根本不是指针目标。
//
// 判据来源（判的是**命中区**，即元素的 border box / getBoundingClientRect，
// 不是 padding/content，也不是视觉图标 —— 元素自己撑到 24 就算达标）。
// ============================================================================

/** WCAG 2.5.8 (AA) 的下限（CSS px）。 */
export const MIN_TAP_TARGET_PX = 24;

/** Spacing 例外里的圆半径（直径 24 ⇒ 半径 12）。 */
export const SPACING_RADIUS_PX = 12;

/**
 * 被审计的元素集合：与 WCAG「UI 组件」的口径对齐 —— 原生可聚焦控件、
 * 显式 role=button 的自绘控件、链接、表单控件、以及 <details> 的 <summary>。
 * <summary> 必须在内：它是原生可点目标，也是本轮实测的对象之一。
 *
 * ★ 刻意**不含**裸容器：判据是「目标」，即真正接收指针事件的元素。父容器放大了
 *   可点面积的情形，靠「父元素自己也在候选集里」体现（例如 .ws-search 与它内部的
 *   .ws-search-input 是**两个**候选，各自被量）。
 */
export const TOUCH_SELECTOR =
  'button,[role="button"],a[href],input,textarea,select,summary';

/** 小数位：几何量按 2 位小数取整（浮点噪声不该让「逐字相同」的断言假红）。 */
export const ROUND = 2;

/**
 * ★ 在**页面里**执行的审计函数（自包含：不引用任何外部作用域，可被序列化后注入）。
 *
 * 为什么用真函数而不是一段字符串：真函数会被 lint/typecheck 看见，字符串不会。
 * 序列化方式见 CLI：`(${auditTouchTargets.toString()})(minPx)`。
 *
 * @param {number} minPx 下限（CSS px）
 * @returns {Array<object>} 每个候选目标的实测几何 + 可达性
 */
export function auditTouchTargets(minPx) {
  // 候选集 = ① 原生控件/显式 role/链接（语义上的目标）
  //          ② **自绘目标**：cursor:pointer 且**自己带 click 监听**的元素。
  // ② 是必须的：本仓的 .sess-leaf / .ws-head 是 <div>/<summary>，它们靠
  // addEventListener('click') 变成目标，但 <div> 不在任何语义选择器里 ——
  // 只扫 ① 会让「⋯ 被整行包住」这件事**根本量不出来**（实测踩到：
  // 桌面断言找不到 div.sess-leaf，因为审计压根没把它当候选）。
  // 判据「自己带监听」而不是「cursor:pointer」：cursor 会继承，
  // 只看它会把行内所有 span 都算成独立目标（实测 40+ 个噪声）。
  const SEL = 'button,[role="button"],a[href],input,textarea,select,summary';
  const SELF_TARGETS = (function () {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      if (getComputedStyle(el).cursor !== 'pointer') continue;
      // 「最外层指针区」：祖先里已经有 cursor:pointer ⇒ 本元素是继承来的，
      // 不是独立目标（否则行内每个 span 都会被算成一个目标，实测 40+ 个噪声）。
      let anc = el.parentElement;
      let nested = false;
      while (anc !== null) {
        if (getComputedStyle(anc).cursor === 'pointer') { nested = true; break; }
        anc = anc.parentElement;
      }
      if (nested) continue;
      out.push(el);
    }
    return out;
  })();
  // 去重：同一个元素可能既命中语义选择器、又命中「最外层指针区」（如 span[role=button]）。
  // 重复计数会让「undersized 有几个」这个数字虚高 —— 审计的数字必须可信。
  const candidates = Array.from(new Set(Array.from(document.querySelectorAll(SEL)).concat(SELF_TARGETS)));
  const r2 = (n) => Math.round(n * 100) / 100;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  /** 人类可读且**稳定**的选择器：id > 唯一 class > tag + class 串。 */
  const cssPath = (el) => {
    if (el.id) return '#' + el.id;
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
    if (cls.length > 0) {
      const sel = el.tagName.toLowerCase() + '.' + cls.join('.');
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch { /* invalid */ }
      return sel;
    }
    return el.tagName.toLowerCase();
  };
  /** 无障碍名（近似）：aria-label > title > placeholder > 文本。 */
  const accName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const title = el.getAttribute('title');
    if (title) return title;
    const ph = el.getAttribute('placeholder');
    if (ph) return ph;
    return (el.textContent || '').trim().slice(0, 40);
  };
  const rows = [];
  for (const el of candidates) {
    // ① 可见性：display/visibility/opacity 与祖先 [hidden]。
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) continue;
    } else {
      const cs0 = getComputedStyle(el);
      if (cs0.display === 'none' || cs0.visibility === 'hidden') continue;
    }
    const cs = getComputedStyle(el);
    // ② pointer-events:none 的元素不接收指针事件 ⇒ 根本不是目标。
    if (cs.pointerEvents === 'none') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    // ③ 在视口内：与视口有交集。（抽屉未拉开时侧栏被 translateX(-100%) 推出屏幕，
    //    此时它不是可达目标 —— 但拉开后就可达，故两种状态都要单独审。）
    const onScreen = rect.right > 0 && rect.bottom > 0 && rect.left < vw && rect.top < vh;
    // ④ 遮挡：目标中心点上的最顶层元素必须是自己、自己的祖先或自己的后代。
    //    （用中心点而非整个矩形：浮层可能只盖住一部分，中心点是「还能不能点」的
    //     最常用近似，也是 Chrome DevTools 的可点性判据。）
    let occluded = false;
    let coveredBy = null;
    if (onScreen) {
      const px = Math.min(Math.max(rect.left + rect.width / 2, 0), vw - 1);
      const py = Math.min(Math.max(rect.top + rect.height / 2, 0), vh - 1);
      const top = document.elementFromPoint(px, py);
      const selfOrKin = top === el || (top !== null && (el.contains(top) || top.contains(el)));
      if (!selfOrKin) {
        occluded = true;
        coveredBy = top === null ? null : cssPath(top);
      }
    }
    rows.push({
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      name: accName(el),
      w: r2(rect.width),
      h: r2(rect.height),
      x: r2(rect.left),
      y: r2(rect.top),
      font: cs.fontSize,
      minHeight: cs.minHeight,
      onScreen,
      occluded,
      coveredBy,
      /** 当前呈现状态下真的能点到（Spacing 判定与违规判定都只在这个集合里做）。 */
      reachable: onScreen && !occluded,
      undersized: rect.width < minPx || rect.height < minPx,
    });
  }
  return rows;
}

/** 点到矩形的欧氏距离（点在矩形内 ⇒ 0）。 */
function pointToRect(cx, cy, r) {
  const dx = Math.max(r.x - cx, 0, cx - (r.x + r.w));
  const dy = Math.max(r.y - cy, 0, cy - (r.y + r.h));
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * ★ Spacing 例外判定（纯函数，可在 node 里对固定样本做变异负控制）。
 *
 * 逐条照标准原文实现，**两种配对用两套阈值**（这不是化简，是原文的两个分句）：
 *   · 「与另一个目标」              → 圆心到**该目标矩形**的距离 >= 12  (r)
 *   · 「与另一个 undersized 目标的圆」→ **圆心距** >= 24              (2r)
 * 对 undersized↔undersized 这一对，用圆心距（而不是圆心到矩形）是**照原文**；
 * 用后者会更严（矩形含自己的圆心），但那不是标准说的东西。
 *
 * ★ 只有**可达**（onScreen ∧ !occluded）的目标参与计算：被浮层盖住的控件不是
 *   当前状态下的指针目标，把它算进来会造出「遮挡型假警报」（见文件头注释）。
 *
 * 返回的 `spacingMargin` 是**归一化余量** = 最近距离 - 该对的阈值（px）：
 *   >= 0 ⇒ 不相交 ⇒ 满足 Spacing 例外；< 0 ⇒ 相交 ⇒ 该目标**违反** 2.5.8。
 * 归一到同一把尺子，是为了让「谁最危险」可以直接比大小。
 */
export function annotateSpacing(rows, minPx = MIN_TAP_TARGET_PX, radius = SPACING_RADIUS_PX) {
  const eligible = rows.filter((r) => r.reachable !== false);
  return rows.map((row) => {
    if (!(row.w < minPx || row.h < minPx)) {
      // 尺寸达标的目标不是 Spacing 例外的对象，无需判定（margin 记 Infinity）。
      return { ...row, spacingPass: true, spacingMargin: Infinity, nearest: null };
    }
    if (row.reachable === false) {
      // 不可达 ⇒ 当前状态下无所谓间距；标记为「不适用」，**不得**算成违规。
      return { ...row, spacingPass: null, spacingMargin: null, nearest: null };
    }
    const cx = row.x + row.w / 2;
    const cy = row.y + row.h / 2;
    let best = Infinity;
    let nearest = null;
    for (const other of eligible) {
      if (other === row) continue;
      if (other.selector === row.selector && other.x === row.x && other.y === row.y) continue;
      const otherUndersized = other.w < minPx || other.h < minPx;
      let dist;
      let threshold;
      if (otherUndersized) {
        const ox = other.x + other.w / 2;
        const oy = other.y + other.h / 2;
        dist = Math.sqrt((ox - cx) * (ox - cx) + (oy - cy) * (oy - cy));
        threshold = radius * 2;
      } else {
        dist = pointToRect(cx, cy, other);
        threshold = radius;
      }
      const margin = dist - threshold;
      if (margin < best) { best = margin; nearest = other.selector; }
    }
    const spacingPass = best >= 0;
    return {
      ...row,
      spacingPass,
      spacingMargin: Number.isFinite(best) ? Math.round(best * 100) / 100 : Infinity,
      nearest,
    };
  });
}

/** 尺寸不足（无论是否命中例外、是否可达）—— 审计的**信息**面，不是结论面。 */
export function findUndersized(rows, minPx = MIN_TAP_TARGET_PX) {
  return rows.filter((r) => r.w < minPx || r.h < minPx);
}

/**
 * ★ 最终判据：**违反** SC 2.5.8 = 可达 ∧ 尺寸不足 ∧ 不满足 Spacing 例外。
 * 不可达的目标一律不算违规（它们当前不是指针目标）。
 */
export function findViolations(rows, minPx = MIN_TAP_TARGET_PX) {
  return annotateSpacing(rows, minPx)
    .filter((r) => r.reachable !== false)
    .filter((r) => r.w < minPx || r.h < minPx)
    .filter((r) => r.spacingPass === false);
}

/** 极简定宽表格（零依赖；CJK 按 2 列宽估算，只为肉眼对齐，不参与断言）。 */
export function formatTable(rows, minPx = MIN_TAP_TARGET_PX) {
  if (rows.length === 0) return '（无：没有任何目标小于 ' + minPx + 'px）';
  const w = (s) => {
    let n = 0;
    for (const ch of String(s)) n += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
    return n;
  };
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - w(s)));
  const head = ['selector', 'tag', 'w', 'h', 'margin', 'verdict', 'note', 'name'];
  const body = rows.map((r) => [
    r.selector, r.tag, r.w, r.h,
    r.spacingMargin === null || r.spacingMargin === undefined || r.spacingMargin === Infinity ? '-' : r.spacingMargin,
    r.spacingPass === false ? '违反' : r.spacingPass === null ? '不适用' : '例外',
    r.reachable === false ? (r.onScreen === false ? 'offscreen' : 'occluded') : '',
    r.name,
  ]);
  const widths = head.map((h, i) => Math.max(w(h), ...body.map((b) => w(b[i]))));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join('  ');
  return [line(head), line(widths.map((n) => '-'.repeat(n))), ...body.map(line)].join('\n');
}

/** 稳定排序：先按「最小边」再按选择器（最严重的排最前）。 */
export function sortWorstFirst(rows) {
  return [...rows].sort((a, b) => {
    const sa = Math.min(a.w, a.h);
    const sb = Math.min(b.w, b.h);
    if (sa !== sb) return sa - sb;
    if (a.selector !== b.selector) return a.selector < b.selector ? -1 : 1;
    return a.y - b.y;
  });
}
