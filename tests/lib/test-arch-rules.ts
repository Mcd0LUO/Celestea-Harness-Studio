/**
 * W9219 · 测试架构门禁的**按名判定**检查器（唯一真源）。
 *
 * 为什么按**标识符名**记账、而不是数「有几条规则」：
 * 按条数记账有**调包漏洞** —— 在一个已冻结的文件里删掉一条旧规则、再加一条**全新**的等价规则，
 * 条数不变，门禁仍然绿。本仓 W9214（未使用变量棘轮）实测复现过这个洞，
 * 所以这里沿用同一套口径：**每条规则有唯一名字，名字缺失即失败**。
 *
 * ★ 调包用例（本文件被 w9219 棘轮用）：传入一个「删掉某条规则 + 加一条等价新规则」的配置，
 * 条数不变但名字缺失 ⇒ **必须变红**。
 */

/** 一条具名规则：`test` 是判定，`why` 是它守的事实（失败信息里直接给出）。 */
export interface NamedRule {
  readonly name: string;
  readonly why: string;
  readonly test: (config: string) => boolean;
}

/** 测试 worker 上限（W9217）必须继续成立的契约。 */
export const WORKER_RULES: readonly NamedRule[] = Object.freeze([
  {
    name: "conditional-injection",
    why: "maxWorkers 必须由条件展开注入，不能无条件赋值（否则 4 核 CI 会被提高并发）",
    test: (c) => /TEST_WORKERS === undefined \? \{\} : \{ maxWorkers: TEST_WORKERS \}/.test(c),
  },
  {
    name: "vitest-default",
    why: "必须算出 vitest 的真实默认 max(cores-1, 1)（不是核数）",
    test: (c) => /Math\.max\(cores - 1, 1\)/.test(c),
  },
  {
    name: "half-cores",
    why: "默认必须取半核 floor(cores/2)",
    test: (c) => /Math\.floor\(cores \/ 2\)/.test(c),
  },
  {
    name: "only-lower",
    why: "必须「只在严格低于 vitest 默认时才设」，否则 undefined（只降不升）",
    test: (c) => /half < vitestDefault \? half : undefined/.test(c),
  },
  {
    name: "env-override",
    why: "必须支持 CELESTEA_TEST_WORKERS 显式覆盖",
    test: (c) => c.includes("CELESTEA_TEST_WORKERS"),
  },
  {
    name: "finite-check",
    why: "覆盖值必须做有限性/正数校验，避免 NaN 传给 vitest",
    test: (c) => /Number\.isFinite\(n\)[\s\S]{0,60}n > 0/.test(c),
  },
  {
    name: "incident-comment",
    why: "注释必须点明真实默认与「无法本地复现」的取舍（v1/v2 两次事故）",
    test: (c) => /SKIPS|跳过|无法本地复现/.test(c),
  },
  {
    name: "no-unconditional-maxworkers",
    why: "默认不得无条件设置 maxWorkers",
    test: (c) => !/^\s*maxWorkers\s*:/m.test(c),
  },
]);

/** 两池架构与平台 fail-closed 必须继续成立的契约。 */
export const POOL_RULES: readonly NamedRule[] = Object.freeze([
  {
    name: "policy-module-imported",
    why: "shared 池必须从平台策略模块取白名单（不得手抄）",
    test: (c) => c.includes("shared-pool-policy.js"),
  },
  {
    name: "platform-gated",
    why: "shared 池必须按 process.platform 判定（非 win32 全部走 isolated）",
    test: (c) => c.includes("sharedPoolEnabled(process.platform)"),
  },
  {
    name: "conditional-project",
    why: "shared project 必须条件注册：非 win32 时整体不注册",
    test: (c) => /SHARED_POOL_ON \? \[/.test(c),
  },
  {
    name: "isolated-excludes-shared",
    why: "isolated 池必须展开 SHARED_ALLOWLIST 排除，否则同一文件被两个 project 采集",
    test: (c) => /ISOLATED_EXCLUDE[\s\S]{0,400}?\.\.\.SHARED_ALLOWLIST/.test(c),
  },
  {
    name: "shared-include-is-allowlist",
    why: "shared 池的 include 必须就是白名单本身",
    test: (c) => /include: \[\.\.\.SHARED_ALLOWLIST\]/.test(c),
  },
  {
    name: "shared-isolate-false",
    why: "shared 池必须显式 isolate:false（否则两池没有意义）",
    test: (c) => /name: "shared"[\s\S]{0,600}?isolate: false/.test(c),
  },
  {
    name: "isolated-project-exists",
    why: "isolated 池必须存在且是默认归宿",
    test: (c) => /name: "isolated"/.test(c),
  },
]);

/** 按名判定：返回缺失的规则名（空数组 = 全过）。 */
export function missingRules(rules: readonly NamedRule[], config: string): string[] {
  return rules.filter((rule) => !rule.test(config)).map((rule) => rule.name);
}

/** 渲染失败信息：名字 + 它守的事实（失败时直接可读）。 */
export function describeMissing(rules: readonly NamedRule[], config: string): string {
  const missing = missingRules(rules, config);
  if (missing.length === 0) return "";
  return missing
    .map((name) => {
      const rule = rules.find((x) => x.name === name);
      return `  · [${name}] ${rule?.why ?? ""}`;
    })
    .join("\n");
}
