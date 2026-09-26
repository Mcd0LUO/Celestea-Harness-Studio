import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

const alias = {
  "@celestea/core": r("./packages/core/src/index.ts"),
  "@celestea/session": r("./packages/session/src/index.ts"),
  "@celestea/llm": r("./packages/llm/src/index.ts"),
  "@celestea/tools": r("./packages/tools/src/index.ts"),
  "@celestea/agent-loop": r("./packages/agent-loop/src/index.ts"),
  "@celestea/workers": r("./packages/workers/src/index.ts"),
  "@celestea/runtime": r("./packages/runtime/src/index.ts"),
  "@celestea/studio": r("./apps/studio/src/index.ts"),
};

/**
 * W847 (test isolation): the ONLY test files that make live HTTP calls to the one
 * running backend (default 127.0.0.1:3777, overridable via CELESTEA_E2E_BASE).
 * Verified by grep: every other test uses an in-process app/harness.
 *
 * They mutate the server's ONE global active_session, so if two of them run at the
 * same time the slower one restores an active that the faster one already deleted
 * (404) and the "active_session must be null" assertion is clobbered by the other
 * file's activate. Run them one at a time; keep everything else parallel.
 *
 * W862 (explicit opt-in — a real incident): running the root `pnpm check` used to hit
 * the LIVE 3777 service, and the multimodal file's deliberate IMAGE_UNSUPPORTED case
 * (a text-only test model fed an image) broadcast a bogus downgrade notice into the
 * user's Studio window. Therefore the default gate must NEVER touch the online service:
 * the real-backend suite only runs when CELESTEA_E2E=1 is set explicitly.
 *
 * - Opted in: the three files run here, serial (fileParallelism=false), assertions intact.
 * - Not opted in: this project collects no files; the three files are instead collected
 *   by the `unit` project and end as a VISIBLE skip (never silently disappear), each
 *   printing the opt-in command. A missing/empty project is not an error as long as the
 *   run has tests, and the in-file `describe.skipIf` gate is the belt-and-braces backstop
 *   so no code path — probe included — can reach 3777 without the switch.
 */
/**
 * 测试 worker 上限（W9217）。
 *
 * 为什么需要：本仓有 **399 个测试文件**、`isolate` 默认 true（**一个文件一个进程**，
 * 每个约 600ms 启动开销）。开发机核多时，`pnpm test` 会同时起几十个 node 进程，
 * 整机在跑测试期间不可用。所以提供一个**可选**的上限。
 *
 * ★ vitest 5 的真实默认**不是核数**，而是 `max(availableParallelism() - 1, 1)`
 *   （`getDefaultThreadsCount`；watch 下是 `max(floor(n/2),1)`）。
 *   我因为这个误解连错两次，两次都在 4 核 CI 上把并发**提了上去**：
 *     v1  无条件 `return 8`               ⇒ CI 默认 3 被提到 8；
 *     v2  `min(8, max(cores-1, 1))`       ⇒ 理论等于默认，但 CI 恰在该提交开始红
 *                                           `main.test.ts` 的 SIGTERM 用例。
 *   而该用例是 `describe.skipIf(!POSIX_PROCESS_GROUPS)` —— 本机（Windows）**跳过**，
 *   所以我**无法本地复现** v2 是否有害。
 *
 * **结论：默认不设**（`return undefined`），让 vitest 用自己的默认 —— CI 行为零变化。
 * **要限制时显式开启**（覆盖值按原样使用，那是操作者明确要求的）：
 *   CELESTEA_TEST_WORKERS=8  pnpm test     # 留出机器余量（本机 32 核实测 ~47s）
 *   CELESTEA_TEST_WORKERS=16 pnpm test     # 快一些（~33s）
 *
 * 实测代价曲线（本仓 3300+ 用例，Windows 32 核；vitest 默认 = 31）：
 *   workers   wall clock
 *   31 (默认)     27 s
 *   16            33 s
 *    8            47 s
 *    4            81 s
 *    2           149 s
 *
 * 为什么不顺手开 `isolate: false`（runner 提示能省 ~7.4s）：本仓有 64 个测试文件用
 * `vi.stubGlobal` 改全局状态，共享模块注册表会让它们互相污染 —— 省下的时间不值这个风险。
 */
const DEFAULT_TEST_WORKERS = 8;

const TEST_WORKERS = (() => {
  const raw = process.env.CELESTEA_TEST_WORKERS;
  if (raw !== undefined && raw.trim() !== "") {
    // An explicit override is honoured as-is: the operator asked for that number.
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_TEST_WORKERS;
  }
  // Default: cap ONLY when that strictly LOWERS vitest's own default.
  //
  // Both earlier attempts RAISED concurrency on a 4-core runner, and both broke CI:
  //   v1  `return 8`                    -> 3 became 8;
  //   v2  `min(8, max(cores-1, 1))`     -> equals the default in theory, yet CI began
  //                                       failing `main.test.ts`'s SIGTERM case at
  //                                       that commit (I could not reproduce it: that
  //                                       suite SKIPS on this Windows dev box).
  // So the rule is now the only one I can PROVE safe: when the cap is not strictly
  // below the default, emit nothing — the resulting config is then identical to
  // having no cap at all, so CI cannot change.
  //
  //   32-core dev box -> default 31 > 8  -> cap to 8   (the machine stays usable)
  //    4-core CI      -> default  3 < 8  -> omit        (byte-identical to before)
  const cores = availableParallelism();
  const vitestDefault = Math.max(cores - 1, 1);
  return vitestDefault > DEFAULT_TEST_WORKERS ? DEFAULT_TEST_WORKERS : undefined;
})();

const E2E = process.env.CELESTEA_E2E === "1";
const REAL_BACKEND = [
  "tests/archive-panel-real-backend.test.ts",
  "tests/multimodal-attachments-real-backend.test.ts",
  "tests/session-gone-real-backend.test.ts",
];
/** 未选入时的占位：文件不存在 ⇒ real-backend project 零文件（选入才装载真实套件）。 */
const REAL_BACKEND_OFF = ["tests/__real-backend-disabled-until-CELESTEA_E2E__.test.ts"];

export default defineConfig({
  test: {
    // W9217: OPTIONAL pool cap (see TEST_WORKERS above). Unset by default so
    // vitest's own default applies untouched; set CELESTEA_TEST_WORKERS to cap it.
    ...(TEST_WORKERS === undefined ? {} : { maxWorkers: TEST_WORKERS }),
    // W839 (R3 B8 / W818-P2-1): the weak-reference release case needs --expose-gc.
    // Vitest 5 removed poolOptions; execArgv is a top-level (and inherited) option.
    execArgv: ["--expose-gc"],
    /**
     * 覆盖率是**诊断**，不是门禁（与 deps:audit 同一定位，DEPENDENCY-POLICY.md §6）。
     * 为什么明确不设 thresholds：本仓门禁的唯一价值是**确定性**——覆盖率随平台/运行波动，
     * 一旦进门禁就会制造「代码没动却红」的假红，正是 §6 拒绝 audit 进门禁的同一条理由。
     * 只统计产品源码：测试自身、包入口（re-export 收口，不含逻辑）与生成物不计入。
     */
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text", "html"],
      reportsDirectory: "coverage",
      include: [
        "packages/*/src/**/*.ts",
        "apps/studio/src/**/*.ts",
        "apps/cli/src/**/*.ts",
        "apps/web/src/**/*.ts",
      ],
      exclude: ["**/*.test.ts", "**/*.test-util.ts", "**/index.ts", "**/*.d.ts"],
      // 诊断工具必须**无论红绿都出数**：默认 reportOnFailure=false 会在有失败用例时
      // 什么都不打印，恰好抹掉最需要覆盖率的时刻。
      reportOnFailure: true,
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          setupFiles: [r("./vitest.setup.ts")],
          // W895：前端（apps/web）此前**零单测**，只靠 tsc + tools/check-*.mjs。
          // 增强缝是行为逻辑（注册/注销/幂等/回滚），静态门禁证明不了 —— 给它一个测试面。
          // DOM 用例在文件头用 `// @vitest-environment jsdom` 单独切环境。
          include: ["packages/**/*.test.ts", "apps/studio/**/*.test.ts", "apps/cli/**/*.test.ts", "apps/web/**/*.test.ts", "tests/**/*.test.ts"],
          // 未选入 E2E 时把三个真实后端文件收在这里（它们自我 skip 并打印选入口令），
          // 于是默认跑看到的是**可见的 skip**；选入后才交还给 real-backend project。
          exclude: ["**/node_modules/**", "**/dist/**", ...(E2E ? REAL_BACKEND : [])],
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "real-backend",
          setupFiles: [r("./vitest.setup.ts")],
          // W862：只有显式选入（CELESTEA_E2E=1）才装载这三个文件；默认零文件，
          // 文件在 unit project 里可见跳过（见上方 REAL_BACKEND 注释）。
          include: E2E ? [...REAL_BACKEND] : [...REAL_BACKEND_OFF],
          // One live server, one active_session: fileParallelism=false runs the
          // three files one at a time (everything else keeps the parallel pool).
          pool: "forks",
          fileParallelism: false,
          testTimeout: 120_000,
        },
      },
    ],
  },
});
