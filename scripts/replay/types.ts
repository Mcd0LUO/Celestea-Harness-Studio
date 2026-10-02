/**
 * 共享形状（从 compare-replay.ts 原样搬出，字段与联合类型逐字未改）。
 *
 * 为什么要单独一份：compare-replay.ts 的 main() 原本把「A–E 五组对拍」和
 * 「报告的形状」都堆在一个文件里，main() 因此涨到 115 行（ESLint
 * max-lines-per-function 的上限是 100，见 ARCHITECTURE.md §5 的 EX-04）。
 * 这次是**纯搬家**：报告文本、退出码、JSON 字段顺序全部不变。
 */

/** 对拍发现的一条记录。 */
export interface Finding {
  scope: string;
  kind: "golden-divergence" | "self-check-divergence" | "info" | "error";
  detail: string;
}

/** 每个会话在报告里的一行。 */
export interface SessionReport {
  id: string;
  slug: string;
  roles: string[];
  events: number;
  turns: number;
  danglingToolCalls: number;
  orphanToolResults: number;
  subCalls: number;
  tornTail: boolean;
  turnIdMonotonic: boolean;
  outcomes: Record<string, number>;
  messages: { golden: number; actual: number; divergences: number };
  derived: { expected: number; actual: number; divergences: number };
  sse: { expected: number; actual: number; divergences: number };
  goldenVerdict: "match" | "divergence";
}

/** renderMarkdown() 读的那部分报告（report 里另有 fixtures 字段，它不参与渲染）。 */
export interface ReportShape {
  generatedAt: string;
  fixturesGeneratedAt: string;
  strict: boolean;
  summary: { sessions: number; goldenComparisons: number; goldenDivergences: number; selfCheckDivergences: number; errors: number; verdict: string };
  sessions: SessionReport[];
  findings: Finding[];
}

/**
 * 一次运行的路径与开关（原先是 compare-replay.ts 的四个模块级常量：
 * FIXTURES / REPORTS / STRICT / MAX_SHOWN）。
 *
 * 抽成显式入参而不是继续用模块级可变状态：各 compareX() 因此是可单测的纯函数入口，
 * 且「谁依赖了哪个开关」在签名上一眼可见。
 */
export interface ReplayConfig {
  fixtures: string;
  reports: string;
  strict: boolean;
  maxShown: number;
}

/** fixtures/index.json 里的一个会话条目。 */
export interface ManifestEntry {
  id: string;
  slug: string;
  roles: string[];
}

/**
 * 对拍期间在模块间流转的可变上下文。
 *
 * findings 与 maxShown 原本是两个模块级 const，compareLists() 及各 compareX()
 * 都隐式依赖它们；抽成显式入参后签名就撞上 max-params（上限 5，见
 * ARCHITECTURE.md §4），于是把这两个「每次运行都不变」的值合成一个对象。
 */
export interface CompareCtx {
  findings: Finding[];
  maxShown: number;
  fixtures: string;
}

/** fixtures/index.json。 */
export interface Manifest {
  generatedAt: string;
  sessions: ManifestEntry[];
}
