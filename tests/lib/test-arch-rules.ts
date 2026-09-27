/**
 * W9217/W9220 · 测试架构门禁的**按名判定**检查器（唯一真源）。
 *
 * 为什么按**标识符名**记账、而不是数「有几条规则」：
 * 按条数记账有**调包漏洞** —— 在一个已冻结的文件里删掉一条旧规则、再加一条**全新**的等价规则，
 * 条数不变，门禁仍然绿。本仓 W9214（未使用变量棘轮）实测复现过这个洞，
 * 所以这里沿用同一套口径：**每条规则有唯一名字，名字缺失即失败**。
 *
 * ★ 调包用例（本文件被 w9217 / w9220 棘轮用）：传入一个「删掉某条规则 + 加一条等价新规则」的配置，
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
    name: "ci-not-throttled",
    why: "核数不够多时不得设上限（4 核 CI 上把 3 降到 2 实测慢 49%），必须用 vitest 默认",
    test: (c) => /cores >= MIN_CORES_TO_CAP && half < vitestDefault \? half : undefined/.test(c),
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

/**
 * W9220 · 执行架构（vmThreads 池 + forks 兜底）必须继续成立的契约。
 *
 * ★ 最重要的一条是 `no-top-level-execargv`：worker_threads **拒绝** `--expose-gc`，
 *   一旦把它放回顶层（全局继承），整个 vmThreads 池起不来
 *   （0 个用例 + ERR_WORKER_INVALID_EXEC_ARGV）。W9219 正是因此**误判 vmThreads 不可用**，
 *   转而去做白名单两池，结果在默认并发下墙钟与改动前相同。这条规则就是那次误判的护栏。
 */
export const POOL_RULES: readonly NamedRule[] = Object.freeze([
  {
    name: "vm-pool",
    why: "主池必须是 vmThreads（VM 上下文隔离：免进程启动，同时保住跨文件隔离）",
    test: (c) => /name: "vm"[\s\S]{0,400}?pool: "vmThreads"/.test(c),
  },
  {
    name: "no-top-level-execargv",
    why: "顶层绝不能有 execArgv（worker 线程拒绝 --expose-gc ⇒ 整个 vmThreads 池起不来）",
    // 顶层 = 4 空格缩进（test 对象内）；project 级是 10 空格，必须允许（gc 兜底需要它）。
    test: (c) => !/^ {4}execArgv\s*:/m.test(c),
  },
  {
    name: "gc-forks-fallback",
    why: "需要真实 --expose-gc 的文件必须单独走 forks project（worker 线程不接受该 flag）",
    test: (c) => /name: "gc"[\s\S]{0,400}?execArgv: \["--expose-gc"\]/.test(c),
  },
  {
    name: "forks-fallback-excluded-from-vm",
    why: "vm 池必须显式排除 forks 兜底文件，否则同一文件被两个 project 采集（重复执行）",
    // exclude 里还有 ...(E2E ? REAL_BACKEND : [])，所以不能用 [^\]]* 限定方括号内。
    test: (c) => /exclude: \[[\s\S]{0,200}?\.\.\.FORKS_ONLY/.test(c),
  },
  {
    name: "forks-fallback-nonempty",
    why: "forks 兜底集合不得为空（chdir / gc / URL 垫片三类文件必须真的被兜住）",
    test: (c) => /FORKS_ONLY = \[\.\.\.CHDIR_FILES, \.\.\.GC_FILES, \.\.\.URL_SHIM_FILES\]/.test(c),
  },
  {
    name: "real-backend-serial",
    why: "real-backend 必须 fileParallelism=false（一个 live server 只有一个 active_session）",
    test: (c) => /name: "real-backend"[\s\S]{0,500}?fileParallelism: false/.test(c),
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