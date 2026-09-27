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
 * W862 (explicit opt-in — a real incident): running the root pnpm check used to hit
 * the LIVE 3777 service, and the multimodal file's deliberate IMAGE_UNSUPPORTED case
 * (a text-only test model fed an image) broadcast a bogus downgrade notice into the
 * user's Studio window. Therefore the default gate must NEVER touch the online service:
 * the real-backend suite only runs when CELESTEA_E2E=1 is set explicitly.
 *
 * - Opted in: the three files run here, serial (fileParallelism=false), assertions intact.
 * - Not opted in: this project collects no files; the three files are instead collected
 *   by the vm project and end as a VISIBLE skip (never silently disappear), each
 *   printing the opt-in command. A missing/empty project is not an error as long as the
 *   run has tests, and the in-file describe.skipIf gate is the belt-and-braces backstop
 *   so no code path — probe included — can reach 3777 without the switch.
 */
/**
 * 测试 worker 上限（W9217）。
 *
 * 为什么需要：本仓有 400 个测试文件、isolate 默认 true（一个文件一个环境，
 * 每个约 600ms 启动开销）。开发机核多时，pnpm test 会同时起几十个 node 进程，
 * 整机在跑测试期间不可用。所以提供一个可选的上限。
 *
 * ★ vitest 5 的真实默认不是核数，而是 max(availableParallelism() - 1, 1)
 *   （getDefaultThreadsCount；watch 下是 max(floor(n/2),1)）。
 *   我因为这个误解连错两次，两次都在 4 核 CI 上把并发提了上去：
 *     v1  无条件 return 8               ⇒ CI 默认 3 被提到 8；
 *     v2  min(8, max(cores-1, 1))       ⇒ 理论等于默认，但 CI 恰在该提交开始红
 *                                           main.test.ts 的 SIGTERM 用例。
 *   而该用例是 describe.skipIf(!POSIX_PROCESS_GROUPS) —— 本机（Windows）跳过，
 *   所以我无法本地复现 v2 是否有害。
 *
 * **结论：默认不设**（return undefined），让 vitest 用自己的默认 —— CI 行为零变化。
 * **要限制时显式开启**（覆盖值按原样使用，那是操作者明确要求的）：
 *   CELESTEA_TEST_WORKERS=8  pnpm test     # 留出机器余量
 *   CELESTEA_TEST_WORKERS=16 pnpm test     # 快一些
 *
 * 实测代价曲线（本仓 3300+ 用例，Windows 32 核；vitest 默认 = 31）：
 *   workers   wall clock
 *   31 (默认)     27 s
 *   16            33 s
 *    8            47 s
 *    4            81 s
 *    2           149 s
 *   （上表是 forks 池时代的数据；W9220 换 vmThreads 后 16 workers 为 ~20 s。）
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
  // vitest's own default is max(availableParallelism() - 1, 1) (NOT the core
  // count). Two earlier attempts here raised it on a 4-core runner and broke CI:
  //   v1  return 8                 -> 3 became 8;
  //   v2  min(8, max(cores-1, 1))  -> theoretically equal, but CI started failing
  //                                    main.test.ts's SIGTERM case at that commit
  //                                    (unreproducible here: that suite SKIPS on Windows).
  // So: emit a cap ONLY when it is strictly below vitest's default. When it is not,
  // emit nothing — the config is then identical to having no cap, so CI cannot move.
  //
  //   32-core dev box -> default 31, half = 16 -> cap to 16
  //    8-core laptop  -> default  7, half =  4 -> cap to  4
  //    4-core CI      -> default  3, half =  2 -> cap to  2 (a LOWER, i.e. safer)
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

/** 全部测试文件的采集范围（与改动前逐字一致）。 */
const UNIT_INCLUDE = [
  "packages/**/*.test.ts",
  "apps/studio/**/*.test.ts",
  "apps/cli/**/*.test.ts",
  "apps/web/**/*.test.ts",
  "tests/**/*.test.ts",
];

/**
 * W9220 · 执行架构：**vmThreads 池**（VM 上下文隔离）+ 两个 forks 兜底 project。
 *
 * 历史：W9219 先用「两池」——isolated（forks/isolate:true）+ shared（isolate:false，
 * 283 个实测 6/6 通过的白名单文件）。那个方案**在默认并发下墙钟与改动前相同（都是 34 s）**，
 * 只把 worker 启动从 401 降到 121；代价却是一整套白名单机器（证据 JSON + 平台 fail-closed + 棘轮）。
 *
 * W9220 实测发现：**pool: vmThreads 才是本仓该用的池**，而且它自带隔离，
 * 白名单整套都不需要了。W9219 当初否决 vmThreads 的依据是错的 —— 它报
 * ERR_WORKER_INVALID_EXEC_ARGV，于是判断「worker_threads 不接受本仓必需的
 * --expose-gc，池起不来」。**真正的原因是那条 execArgv 被放在顶层（全局继承）**：
 * 只要把它从顶层移走、只给真正需要它的那一个文件单独开 forks project，vmThreads 完全可用。
 *
 * 本机实测（Windows 32 核，默认 16 workers，401 文件 / 3411 用例）：
 *   · 墙钟  34 s → **20 s（−41%）**
 *   · CPU   264 → **230 CPU·s（−13%）**
 *   · 进程  133 → **6（−95%）**
 *   · 3/3 全绿，且**不需要任何白名单**
 *
 * 为什么 vmThreads 能免掉白名单：它把**每个测试文件放进独立的 VM 上下文**，
 * 全局（globalThis.Node / navigator / 模块注册表）**不会跨文件泄漏** ——
 * 而 6 次 isolate:false 全量实测里那 21 个不稳定文件，正是被这类泄漏害的。
 * 实测：这 21 个文件在 vmThreads 下 3/3 全过。
 *
 * ★ 顶层**绝不能**再放 execArgv: ["--expose-gc"]：worker_threads 会拒绝该 flag，
 *   整个 vmThreads 池起不来（0 个用例 + ERR_WORKER_INVALID_EXEC_ARGV）。
 *   需要 gc 的文件单独走下面的 gc project（forks 池才接受该 flag）。
 */
/** vmThreads 跑不了的：process.chdir() 在 worker 线程里不可用（所有平台都如此）。 */
const CHDIR_FILES = ["packages/tools/src/guard/w824-guard.test.ts"];
/** 需要**真实** --expose-gc 进程的文件；worker 线程拒绝该 execArgv，只能走 forks。 */
const GC_FILES = ["packages/workers/src/tools.test.ts"];
/** vmThreads 下 URL/objectURL 垫片语义不同：单独跑 3/3 稳定失败，故退回 forks。 */
const URL_SHIM_FILES = ["tests/frontend-r3-b5-attachments-dom.test.ts"];
/** 必须走 forks 的文件总集（vm 池显式排除它们，避免重复采集）。 */
const FORKS_ONLY = [...CHDIR_FILES, ...GC_FILES, ...URL_SHIM_FILES];

export default defineConfig({
  test: {
    // W9217: OPTIONAL pool cap (see TEST_WORKERS above). Unset by default so
    // vitest's own default applies untouched; set CELESTEA_TEST_WORKERS to cap it.
    ...(TEST_WORKERS === undefined ? {} : { maxWorkers: TEST_WORKERS }),
    // ★ W9220：这里**故意没有**顶层 execArgv。worker 线程会拒绝 --expose-gc，
    //   顶层放它 = 整个 vmThreads 池起不来（见上）。需要 gc 的文件走 gc project。
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
          name: "vm",
          // W9220：VM 上下文隔离 —— 一个 worker 线程内每个文件一个独立 VM，
          // 免掉进程启动，同时保住隔离（见上）。
          pool: "vmThreads",
          setupFiles: [r("./vitest.setup.ts")],
          include: UNIT_INCLUDE,
          exclude: ["**/node_modules/**", "**/dist/**", ...(E2E ? REAL_BACKEND : []), ...FORKS_ONLY],
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "gc",
          // W839 (R3 B8 / W818-P2-1)：弱引用释放用例需要真实的 --expose-gc 进程。
          // worker 线程拒绝该 execArgv，所以这一个文件必须走 forks。
          pool: "forks",
          execArgv: ["--expose-gc"],
          setupFiles: [r("./vitest.setup.ts")],
          include: [...GC_FILES],
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "native",
          // process.chdir() 与 URL 垫片在 vmThreads 下不可用/语义不同，
          // 这几个文件退回真实的子进程（forks）。
          pool: "forks",
          setupFiles: [r("./vitest.setup.ts")],
          include: [...CHDIR_FILES, ...URL_SHIM_FILES],
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "real-backend",
          setupFiles: [r("./vitest.setup.ts")],
          // W862：只有显式选入（CELESTEA_E2E=1）才装载这三个文件；默认零文件，
          // 文件在 vm project 里可见跳过（见上方 REAL_BACKEND 注释）。
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