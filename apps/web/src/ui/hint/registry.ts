// ============================================================================
// ui/hint/registry.ts — 悬浮提示的**注册缝**（W790 · item 4）
// ----------------------------------------------------------------------------
// 为什么是「缝」而不是一套插件系统：DSH 的客户端插件是真包（package.json 的
// `dsh.client` 清单 + tsdown 产物 lib/client.js + 宿主 /plugins 分发 + cordis
// fiber + HMR 换纤，见 W790 报告的「DSH 调研」一节），本仓是**单 Vite 产物、
// 无 cordis、无 React、门禁只有体积棘轮**，装不下那条管线。这里只抄它的**形状**：
//   · 具名提供者（id 即身份，同名覆盖 = 重新挂载）；
//   · register(...) → dispose（对齐 DSH `ctx.<registry>.register()` 的注销器）；
//   · 单一挂载点 + 「谁认领谁渲染」的优先级裁决。
// 代价：两个小模块 + 一个注册点，零构建/HMR/门禁改动（这正是取舍依据）。
// ============================================================================

/**
 * W9106 · 悬停停留阈值**按提供者区分**（这是本轮的口径，不是引擎的一刀切）。
 *
 * 为什么不做「全站 0 延迟」：
 *   · 密集控件（会话树每行、设置页每格、状态栏每个按钮）上的纯文本提示是**装饰性**
 *     的：指针扫过去时它不该冒出来 —— 150ms 是 W790 从 rail 沿用的既有手感，保持不变。
 *   · 灵动条（rail）的预览卡是**内容性**的：用户明确要求「应该几乎立即渲染」。条带上
 *     的命中目标每帧重算（fisheye）、长条只有 5px 高，指针很容易滑过 —— 150ms 停留
 *     意味着来回扫动时几乎永远看不到卡。那里也没有「误触弹卡」的风险，只有现状差。
 * 于是延迟成为提供者的属性（provider 级 = 本提供者所有目标的缺省，handle 级 = 具体
 * 目标的覆盖），两级都没有时回落到引擎的 HINT_DELAY_MS（唯一真源在 ./card.ts）。
 */
export interface HintHandle {
  /** 卡片内容；返回 null = 只登记提示文本、不弹卡（如纯原生 title 场景）。 */
  build(): HTMLElement | null;
  /**
   * W9345：**就地更新已有卡片**（可选）—— 把 box 改成当前目标的内容，不换节点。
   * 缺省 = 提供者不承诺同源复用，引擎每次换目标都重新 build（+ 原子替换，见 card.ts）。
   *
   * 契约：update 必须在**它自己 build 出来的那种** box 上正确工作（可以也必须假设
   * box 是本提供者上一张卡的节点）。引擎只在「当前卡与新 handle 出自**同一个**提供者」
   * 时才调它（来源 = handle.providerId，即注册缝给的身份，见下），因此提供者永远
   * 只需要认识自己的卡：不同提供者之间不会互相塞内容（纯文本卡的内容不会进 rail 富卡）。
   * 实现形状见 ui/rail-card.ts：骨架建一次，更新只改文本/显隐/class。
   */
  update?(box: HTMLElement, anchor: HTMLElement): void;
  /** 自定义落位（缺省 = 锚点右下 12px，贴边回退）。 */
  position?(card: HTMLElement, anchor: HTMLElement): void;
  /** W9106：本目标的悬停停留阈值（ms）；缺省 = 提供者级 → 引擎缺省。 */
  delayMs?: number;
  /**
   * W9345：**由 resolveHint 填的**提供者身份（判据的唯一来源，ui/hint/card.ts 据它决定
   * 能不能复用上一张卡）。提供者**不要**自己写这个字段 —— 引擎用注册表里的 id 覆盖，
   * 免得同一提供者认领的两条路径被写成两个身份、或有人拿 className 冒充身份。
   * 认领结果是可选值；引擎读它时按「undefined = 不可复用」处理。
   */
  providerId?: string;
}

/** 一个提示提供者（= 内置插件）。 */
export interface HintPlugin {
  /** 提供者身份：诊断与测试读它，重复注册视为重新挂载（后者胜）。 */
  id: string;
  /** 认领优先级，大者优先（内置纯文本卡 = 0，rail 富卡片 = 10）。 */
  priority?: number;
  /** W9106：本提供者的悬停停留阈值（ms）；handle 上的同名字段更具体、优先。 */
  delayMs?: number;
  /** 认领一个提示目标；不认领返回 null（交给下一个提供者）。 */
  claim(target: HTMLElement, text: string): HintHandle | null;
}

const plugins: HintPlugin[] = [];

/**
 * 注册一个提示提供者，返回注销器（对齐 DSH `register(...) → dispose`）。
 * 幂等：同 id 重复注册 = 用新实现替换旧的（HMR/重挂载语义）。
 */
export function registerHintPlugin(plugin: HintPlugin): () => void {
  const i = plugins.findIndex((p) => p.id === plugin.id);
  if (i >= 0) plugins[i] = plugin;
  else plugins.push(plugin);
  plugins.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return () => {
    const j = plugins.indexOf(plugin);
    if (j >= 0) plugins.splice(j, 1);
  };
}

/** 当前注册的提供者（按优先级降序；诊断/测试用只读快照）。 */
export function hintPlugins(): readonly HintPlugin[] {
  return plugins.slice();
}

/**
 * 首个认领该目标的提供者（null = 无人认领 → 调用方退回原生 title）。
 * W9106：认领结果带上**生效的停留阈值**（handle 级 > provider 级 > 引擎缺省），
 * 于是引擎只需读一个字段，提供者不必知道引擎的缺省值是多少。
 *
 * W9345：同时把 **providerId = 提供者的 id** 盖在返回的 handle 上（**注册缝给的
 * 身份**，不是提供者自报的）。这是引擎决定「能不能在原节点上就地换内容」时唯一的
 * 判据来源 —— 由此杜绝两件事：① 用 className / querySelector 嗅探谁画的卡（换一套
 * 样式名就失灵）；② 提供者把自己的身份写在 handle 上（能被随手冒充）。
 * 补字段只在**真的缺**时发生（少一次对象拷贝，也让「认领结果与 handle 同一对象」
 * 这条既有性质在 provider 无缺省值时保持不变）。
 */
export function resolveHint(target: HTMLElement, text: string): HintHandle | null {
  for (const p of plugins) {
    // W1479: a provider that throws must not kill the whole chain — the next
    // candidate still gets its turn (DSH's "abdicate" semantics: the failed entry
    // steps aside, the rest keeps working). Reported WITH the id.
    try {
      const h = p.claim(target, text);
      if (!h) continue;
      const noDelay = p.delayMs === undefined || h.delayMs !== undefined;
      if (noDelay && h.providerId === p.id) return h;
      return { ...h, delayMs: noDelay ? h.delayMs : p.delayMs, providerId: p.id };
    } catch (err) {
      console.warn('[hint] provider "' + p.id + '" threw', err);
    }
  }
  return null;
}
