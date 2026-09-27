import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { sharedPoolEnabled, sharedPoolFiles } from "./tests/lib/shared-pool-policy.js";

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
 *   by the `isolated` project and end as a VISIBLE skip (never silently disappear), each
 *   printing the opt-in command. A missing/empty project is not an error as long as the
 *   run has tests, and the in-file `describe.skipIf` gate is the belt-and-braces backstop
 *   so no code path — probe included — can reach 3777 without the switch.
 */
const TEST_WORKERS = (() => {
  const raw = process.env.CELESTEA_TEST_WORKERS;
  if (raw !== undefined && raw.trim() !== "") {
    // An explicit override is honoured as-is: the operator asked for that number.
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
  }
  // Default: HALF the cores — and only ever LOWER, never raise.
  //
  // vitest's own default is `max(availableParallelism() - 1, 1)` (NOT the core
  // count). Two earlier attempts here raised it on a 4-core runner and broke CI:
  //   v1  `return 8`                 -> 3 became 8;
  //   v2  `min(8, max(cores-1, 1))`  -> theoretically equal, but CI started failing
  //                                    `main.test.ts`'s SIGTERM case at that commit
  //                                    (unreproducible here: that suite SKIPS on Windows).
  // So: emit a cap ONLY when it is strictly below vitest's default. When it is not,
  // emit nothing — the config is then identical to having no cap, so CI cannot move.
  //
  //   32-core dev box -> default 31, half = 16 -> cap to 16
  //    8-core laptop  -> default  7, half =  4 -> cap to  4
  //    4-core CI      -> default  3, half =  2 -> cap to  2 (a LOWER, i.e. safer)
  // 实测代价曲线（本仓 3300+ 用例，Windows 32 核；vitest 默认 = 31）：
  //   workers   wall clock
  //   31 (默认)     27 s
  //   16            33 s
  //    8            47 s
  //    4            81 s
  //    2           149 s
  //
  // 为什么当初不顺手开 `isolate: false`（runner 提示能省 ~7.4s）：本仓有 64 个测试文件用
  // `vi.stubGlobal` 改全局状态，共享模块注册表会让它们互相污染 —— 省下的时间不值这个风险。
  // ★ W9219 复核了这条结论：**全局共享确实不可行**（6 次全量实测不稳定并集 21 文件，
  //   无一 6/6 失败），但**白名单式共享**可行（283 文件、6/6 证据、3 次全量 3/3 绿）——
  //   见下方 SHARED_ALLOWLIST 与 tests/lib/shared-pool-policy.ts。
  const cores = availableParallelism();
  const vitestDefault = Math.max(cores - 1, 1);
  const half = Math.max(Math.floor(cores / 2), 1);
  return half < vitestDefault ? half : undefined;
})();

const E2E = process.env.CELESTEA_E2E === "1";
const REAL_BACKEND = [
  "tests/archive-panel-real-backend.test.ts",
  "tests/multimodal-attachments-real-backend.test.ts",
  "tests/session-gone-real-backend.test.ts",
];
/** 未选入时的占位：文件不存在 ⇒ real-backend project 零文件（选入才装载真实套件）。 */
const REAL_BACKEND_OFF = ["tests/__real-backend-disabled-until-CELESTEA_E2E__.test.ts"];

/**
 * W9219 · 两池测试架构（isolated / shared）——用**实测**换掉「一个文件一个进程」。
 *
 * 问题（本机 32 核、vitest 5.0.1、400 个测试文件实测）：isolate 默认 true = 一文件一进程，
 * 每个进程约 600ms 启动。40 个"空转"文件的对照实验：
 *     isolate:true  40 个进程 / 1.8s
 *     isolate:false  4 个进程 / 0.6s   ⇒ 启动开销是主要成本，而它集中在大量轻文件上。
 * 但全局 `isolate:false` 一把梭**不可行**：本仓 6 次全量实测（架构师 3 次 + W9219 3 次）
 * 的不稳定文件并集有 21 个，且**没有一个是 3/3 失败**——这是跨文件不确定性，不是固有缺陷。
 * 根因已用最小探针钉死：`isolate:false` 下 jsdom 全局**真的会跨文件泄漏**
 * （探针：A 文件 stub navigator= en-US / body.innerHTML="<b>poisoned</b>"，B 文件读到的就是
 *  en-US + poisoned；`isolate:true` 下 B 读到的是干净值）。故：
 *
 *   · isolated 池（isolate:true）—— 默认归宿，装一切**未被实测证明**的文件；
 *   · shared   池（isolate:false）—— 只装白名单，白名单来自 6 次全量运行的原始 JSON。
 *
 * ★ fail-closed：新文件默认进 isolated。只有**实测 6/6 通过**、非 jsdom、非 real-backend
 *   的文件才会被登记进 `tests/lib/shared-pool-allowlist.json`；该表由
 *   `tests/w9219-test-pool-ratchet.test.ts` 钉住（表外文件混进 shared 即红）。
 *
 * 候选 B（`pool:"vmThreads"`）已**实测否决**：node 的 worker_threads 拒绝本仓必需的
 *   `execArgv:["--expose-gc"]`，报 `ERR_WORKER_INVALID_EXEC_ARGV`，全量 0 个用例、17 个错误。
 * 候选 C（jsdom 降级）实测收益≈0：96 个 jsdom 文件里只有 4 个完全不碰 DOM 全局。
 */
const SHARED_POOL_ON = sharedPoolEnabled(process.platform);
const SHARED_ALLOWLIST: readonly string[] = Object.freeze([...sharedPoolFiles(process.platform)]);
/** unit 面（isolated 池的采集范围，与改动前的 unit project 逐字一致）。 */
const UNIT_INCLUDE = [
  "packages/**/*.test.ts",
  "apps/studio/**/*.test.ts",
  "apps/cli/**/*.test.ts",
  "apps/web/**/*.test.ts",
  "tests/**/*.test.ts",
];
/** isolated 池必须**显式排除**白名单，否则同一文件被两个 project 采集（重复执行）。 */
const ISOLATED_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  ...(E2E ? REAL_BACKEND : []),
  ...SHARED_ALLOWLIST,
];

export default defineConfig({
  test: {
    // W9217: OPTIONAL pool cap (see TEST_WORKERS above). Unset by default so
    // vitest's own default applies untouched; set CELESTEA_TEST_WORKERS to cap it.
    ...(TEST_WORKERS === undefined ? {} : { maxWorkers: TEST_WORKERS }),
    // W839 (R3 B8 / W818-P2-1): the weak-reference release case needs --expose-gc.
    // Vitest 5 removed poolOptions; execArgv is a top-level (and inherited) option.
    // ★ 不要把它挪进 project：vmThreads 池会因此整池起不来（见上）。
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
          name: "isolated",
          setupFiles: [r("./vitest.setup.ts")],
          // 默认池：isolate 不写 = vitest 默认 true = 一文件一进程，隔离强度与改动前一致。
          include: UNIT_INCLUDE,
          exclude: ISOLATED_EXCLUDE,
          testTimeout: 30_000,
        },
      },
      // ★ W9219：shared 池**只在 win32 启用**（见 tests/lib/shared-pool-policy.ts）。
      // 白名单证据只在 Windows 采集，而白名单里有 20 个带条件跳过（平台或能力探测）的文件；
      // 它们到 Linux 会真跑（最危险的是 main.test.ts 的 SIGTERM 用例，正是历史 CI 事故那条）。
      // 非 win32 ⇒ SHARED_ALLOWLIST 为空 ⇒ 下面这个 project 整体不注册 ⇒ 全部文件走 isolated
      // （= 改动前行为）⇒ ubuntu CI 行为零变化。fail-closed：只降并发，不升。
      ...(SHARED_POOL_ON ? [{
        resolve: { alias },
        test: {
          name: "shared",
          setupFiles: [r("./vitest.setup.ts")],
          include: [...SHARED_ALLOWLIST],
          // 白名单文件共享进程：省掉每文件约 600ms 的进程启动。
          // 隔离强度由白名单的实测来源保证（6/6），不靠 vitest 兜底。
          isolate: false,
          testTimeout: 30_000,
        },
      }] : []),
      {
        resolve: { alias },
        test: {
          name: "real-backend",
          setupFiles: [r("./vitest.setup.ts")],
          // W862：只有显式选入（CELESTEA_E2E=1）才装载这三个文件；默认零文件，
          // 文件在 isolated project 里可见跳过（见上方 REAL_BACKEND 注释）。
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
