import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

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
 * 为什么需要：vitest 5 的 `maxWorkers` **默认等于 CPU 核数**。本仓有 **399 个测试文件**、
 * 且 `isolate` 默认为 true（**一个文件一个进程**，每个约 600ms 启动开销）。在 32 核的
 * 开发机上，`pnpm test` 会同时起 **32 个 node 进程**，整机在跑测试期间不可用。
 *
 * 实测代价曲线（本仓 3309 个用例，Windows 32 核）：
 *   workers   wall clock
 *   32 (默认)     27 s
 *   16            33 s
 *    8            47 s
 *    4            81 s
 *    2           149 s
 *
 * 默认取 **8**：对「别把机器占满」是真实有效的限制，代价有界。
 * CI runner 是 4 核，所以 8 这个上限**不改变 CI 的行为**（它本来也用不到 8）。
 * 单次运行可用环境变量覆盖：
 *   CELESTEA_TEST_WORKERS=16 pnpm test
 *   CELESTEA_TEST_WORKERS=32 pnpm test     # 恢复旧行为（最快）
 *
 * 为什么不顺手开 `isolate: false`（runner 提示能省 ~7.4s）：本仓有 64 个测试文件用
 * `vi.stubGlobal` 改全局状态，共享模块注册表会让它们互相污染 —— 省下的时间不值这个风险。
 */
const TEST_WORKERS = (() => {
  const raw = process.env.CELESTEA_TEST_WORKERS;
  if (raw === undefined || raw.trim() === "") return 8;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 8;
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
    // W9217: cap the pool (see TEST_WORKERS above). Applies to both projects; the
    // real-backend project already forces fileParallelism=false.
    maxWorkers: TEST_WORKERS,
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
