// @ts-check
/**
 * celestea_studio-ts —— 架构规则的机械强制（ESLint flat config）。
 *
 * 这里只放「结构类」规则：文件/函数规模、嵌套深度、参数个数、跨包导入边界、
 * 未使用绑定（导入/变量/类型）。
 * 与 dependency-cruiser（`pnpm lint:arch`）分工：
 *   - ESLint      = 单文件粒度的静态形状（规模 + 导入字面量）
 *   - dep-cruiser = 仓级依赖图（分层方向、循环、深层导入、不可解析）
 *
 * 规则正文见 docs/ARCHITECTURE.md §3/§4，例外清单见 §5。
 * 例外只能登记在下方 ARCH_EXCEPTIONS（唯一真源），每条必须有 原因 / 拆分方案 / 移除阶段。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import tseslint from "typescript-eslint";

/** 单文件规模上限（跳过空行与注释）。W9103：400 → 450（用户裁决）。 */
const MAX_LINES = 450;
/**
 * 单函数规模上限（跳过空行与注释）。
 *
 * 80 → 100 的放宽依据（证据在 docs/ARCHITECTURE.md §4.1 注）：实测把阈值提到 100 时，
 * 非测试源码里只剩 3 个文件越线，且这 3 个全在当时的 ARCH_EXCEPTIONS 里（EX-02/03/04），
 * 也就是说「当前干净的文件一个都没被放过」—— 放宽**不减少任何现存覆盖**，只是给新代码 20 行余量。
 *
 * **2026-10-02 更新**：那 3 个文件（连同 EX-01 的 redact.ts）都已按各自的拆分方案重构完毕，
 * ARCH_EXCEPTIONS 现在是**空表**，`ARCH_STRICT=1 pnpm exec eslint .` 输出 0 条 ——
 * 所以「放宽到 100 会放过干净文件」这条判断至今没有被证伪：阈值承重，例外表没有变成挡箭牌。
 * 回滚：把本常量改回 80 即可（无其它文件依赖这个数），ARCHITECTURE.md §4.1 与本注释同步改回。
 */
const MAX_LINES_PER_FUNCTION = 100;
/** 控制流嵌套上限。 */
const MAX_DEPTH = 4;
/** 形参个数上限。 */
const MAX_PARAMS = 5;
/** 回调嵌套上限。 */
const MAX_NESTED_CALLBACKS = 4;

/**
 * W781：前端并入本仓（`apps/web/`）后，前端的 `apps/web/src/**`（DOM + Vite 语义）
 * 由它自己的 `apps/web/tsconfig.json` 与 7 道门禁管，不归本仓后端工具链。
 * 因此这里（以及 tsconfig/vitest/depcruise）只收 `apps/studio`，不再用 `apps/*` 通配。
 */
const SOURCE_GLOBS = ["packages/*/src/**/*.ts", "apps/studio/src/**/*.ts", "apps/cli/src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"];
/** 测试文件的规模规则照旧，但允许 import 自己被测的包。 */
const TEST_GLOBS = ["**/*.test.ts", "**/*.test-util.ts", "**/*.spec.ts"];

/** 第 1 层：只允许依赖 core。 */
const TIER1 = ["session", "llm", "tools", "agent-loop", "workers", "swarm"];
/** 第 2 层：装配层，允许依赖 core + 第 1 层。 */
const TIER2 = ["runtime"];

const lines = (max) => ["error", { max, skipBlankLines: true, skipComments: true }];
const linesPerFunction = (max) => ["error", { max, skipBlankLines: true, skipComments: true, IIFEs: true }];

/**
 * 已知规模例外（唯一真源；docs/ARCHITECTURE.md §5 逐条对应）。
 * 只放宽被点名文件被点名的那一条规则，不用通配符、不放宽整目录。
 * 复核：`ARCH_STRICT=1 pnpm lint` 会忽略全部例外，输出即为「例外清单清零后的真实违规」。
 */
/**
 * **当前为空**（2026-10-02）：EX-01..EX-04 全部拆除。拆除的依据不是「时间到了」，而是
 * `ARCH_STRICT=1 pnpm exec eslint .` 的输出 —— 它忽略全部例外、只报真实违规，
 * 现在输出 **0 条**。也就是说这四条豁免此前都还承重，拆掉它们的四个重构是真的把越线消掉了，
 * 而不是把阈值放宽（放宽的话这里会多出新的越线文件）。
 *
 * 空表仍然承重：任何新代码越线立刻是 error。新增例外必须**同时**改本节与
 * `docs/ARCHITECTURE.md` §5，并写清 原因 / 拆分方案 / 移除阶段 ——
 * `tests/doc-conventions.test.ts` ⑧ 会逐条比对两处，缺一即红。
 */
const ARCH_EXCEPTIONS = [];

/**
 * 生成「只放宽被点名文件被点名规则」的 override 条目。
 * `ARCH_STRICT=1 pnpm lint` 会忽略全部例外，用于定期复核例外是否还有必要（ARCHITECTURE.md §5）。
 */
const exceptionOverrides = (process.env.ARCH_STRICT === "1" ? [] : ARCH_EXCEPTIONS).map((ex) => ({
  name: `arch-exception/${ex.id}`,
  files: ex.files,
  rules: ex.rules,
}));

const DEEP_IMPORT = {
  group: ["@celestea/*/*"],
  message: "跨包深层导入被禁止：只允许 `@celestea/<pkg>`，公开 API 收口在该包 src/index.ts。",
};
const DEEP_RELATIVE = {
  group: ["../../*", "../../../*"],
  message: "禁止跨目录深层相对导入：包内用 `./x.js`，跨包用 `@celestea/<pkg>`。",
};

const ALL_TIER_PACKAGES = TIER1.concat(TIER2);

/** 跨包边界说明文案。 */
const MSG_CORE_LEAF = "packages/core 是零依赖叶子层：不得依赖任何其他 @celestea 包（ARCHITECTURE.md §1）。";
const MSG_NO_APPS = "反向依赖被禁止：packages/* 不得依赖 apps/studio（ARCHITECTURE.md §1）。";
const MSG_TIER1 = "第 1 层包只允许依赖 @celestea/core；横向能力走 core 的 seam，或在评审中显式登记依赖矩阵（ARCHITECTURE.md §1）。";

/**
 * 组装某类文件的完整 no-restricted-imports 模式表。
 * 注意：ESLint 的规则配置是「整体覆盖」而非「按模式合并」，
 * 因此每个 files 块都必须自带完整的模式清单，不能依赖前一个块。
 */
function boundaryPatterns({ coreLeaf = false, noApps = false, tier1 = false } = {}) {
  const patterns = [];
  if (coreLeaf) {
    patterns.push({ group: ALL_TIER_PACKAGES.concat("studio").map((p) => `@celestea/${p}`), message: MSG_CORE_LEAF });
  }
  if (noApps) {
    patterns.push({ group: ["@celestea/studio"], message: MSG_NO_APPS });
  }
  if (tier1) {
    patterns.push({ group: ALL_TIER_PACKAGES.map((p) => `@celestea/${p}`), message: MSG_TIER1 });
  }
  patterns.push(DEEP_IMPORT, DEEP_RELATIVE);
  return patterns;
}

/**
 * W9214 —— 未使用绑定（导入 / 变量 / 类型 / 接口）棘轮。
 *
 * 现状：本仓从未启用过任何 unused-vars 规则，`pnpm lint` 对死导入完全失明。
 * 真实后果：`apps/studio/src/store/workspaces.ts` 的 `import { renameSync }` 一直没人用，
 * 直到 W9206-28 靠人眼发现。前端（apps/web）一直由自己的 tsconfig 用
 * noUnusedLocals/noUnusedParameters 管着；根 tsconfig 没有这两条，
 * 于是 packages / apps/studio / apps/cli / scripts / tests 是唯一的缺口 —— 本规则补它。
 *
 * 规则参数是**实测**选的（无基线裸跑 `npx eslint .` 逐项对比，非照抄示例）：
 *   · args: "none"         —— 默认 after-used 会多报 15 处「回调签名里的占位参数」，
 *                             那些参数是接口形状的一部分，删掉会改签名，不是死代码；
 *   · varsIgnorePattern ^_ —— 沿用 apps/web/tsconfig.json 的 noUnusedLocals 约定，
 *                             显式命名 `_x` 即声明「我故意不用」；
 *   · caughtErrors: "none" —— catch 绑定常被刻意保留（将来要读 error 的位置）；
 *   · ignoreRestSiblings   —— `const { a, ...rest } = o` 里 a 是「取出去丢掉」的惯用法。
 * 实测口径：不带任何参数 = 111 处（59 文件）；加上上面四条 = 96 处（52 文件）。
 *
 * 棘轮为什么按**标识符名**记账，而不是用 ESLint 内建的 suppressions：
 * 内建机制按**条数**记账，实测存在「调包」漏洞 —— 在一个已冻结的文件里
 * 删掉一条旧违规、再加一条**全新**的未使用变量，条数不变，`npx eslint .` 仍然 EXIT=0
 * （W9214 实测复现）。按名字记账后，任何不在表内的标识符都会报错。
 */
/**
 * 冻结清单（棘轮：只许**缩短**，不许加长）。
 * key = 相对本配置目录的路径（正斜杠）；value = 该文件里已存在的未使用绑定名。
 * `packages/` / `apps/studio/src` / `apps/cli/src` / `scripts` 早已全部清零，未留一条冻结项。
 * `tests/` 的 24 处也已在 W9272 清零（19 个文件 → 只剩下面 2 条**活样本**）。
 * 清理方向：把某个文件清干净后，**同时**删掉它在这里的条目（ARCH_STRICT=1 会因陈旧项报错）。
 */
const UNUSED_VARS_FROZEN = {
  // ★ 仅存的 2 条冻结项，都是 tests/w9214-unused-vars-ratchet.test.ts 的**活样本**：
  //   删掉任何一条，该文件里「冻结名保持绿」/「陈旧项提醒收紧」两条用例就会红。
  //   （msgs 见该文件 :55 与 :61 的两条用例；KEY 见 :73 的「已清干净 ⇒ 提醒收紧」。）
  //   ⇒ 想清理这 2 个文件里的未使用绑定，必须**同时**换掉那条用例的样本，不能单删表项。
  "tests/w895l-plugin-library.test.ts": ["KEY"],
  "tests/w9204-rail-layout.test.ts": ["msgs"],
};

const UNUSED_VARS_RULE = tseslint.plugin.rules["no-unused-vars"];
/** 上面实测选出的四条参数（唯一真源，两条规则共用）。 */
const UNUSED_VARS_OPTIONS = {
  args: "none",
  varsIgnorePattern: "^_",
  caughtErrors: "none",
  ignoreRestSiblings: true,
};

/** 冻结表 / 路径口径的基准目录 = 本配置文件所在目录（不依赖 cwd）。 */
const CONFIG_ROOT = path.dirname(fileURLToPath(import.meta.url));

/** 相对本配置目录的正斜杠路径（冻结表的 key 口径，Windows 上也一致）。 */
function relPathOf(context) {
  const filename = String(context.filename ?? context.getFilename());
  return path.relative(CONFIG_ROOT, filename).split(path.sep).join("/");
}

/**
 * 冻结版 no-unused-vars：**同名**命中冻结表的报告被吞掉，其余照报。
 * 一个名字只放行一次（同名重复违规仍会报）。
 */
const frozenUnusedVarsRule = {
  meta: { ...UNUSED_VARS_RULE.meta },
  create(context) {
    const remaining = new Set(UNUSED_VARS_FROZEN[relPathOf(context)] ?? []);
    const proxy = Object.create(context);
    Object.defineProperty(proxy, "report", {
      value(descriptor) {
        const name = descriptor?.data?.varName;
        if (name !== undefined && remaining.delete(name)) return;
        context.report(descriptor);
      },
      configurable: true,
      enumerable: true,
      writable: true,
    });
    return UNUSED_VARS_RULE.create(proxy);
  },
};

/**
 * 冻结表的「陈旧项」检查：某条冻结名已不再违规（被清理了）⇒ 提醒收紧表。
 * 默认 **warn**（不影响退出码）：本仓是多 worker 共用一个工作树，
 * 别人清理 tests/ 里的违规是好事，不该让他的成功把门禁搞红 ——
 * 与 `apps/web/tools/check-module-size.mjs` 对陈旧项的处理同一条理由。
 * CI 要收紧时置 `ARCH_STRICT=1`，陈旧项即失败。
 */
const staleFrozenUnusedVarsRule = {
  meta: { ...UNUSED_VARS_RULE.meta },
  create(context) {
    const frozen = UNUSED_VARS_FROZEN[relPathOf(context)];
    if (frozen === undefined) return {};
    const stillUnused = new Set();
    const proxy = Object.create(context);
    Object.defineProperty(proxy, "report", {
      value(descriptor) {
        const name = descriptor?.data?.varName;
        if (name !== undefined) stillUnused.add(name);
      },
      configurable: true,
      enumerable: true,
      writable: true,
    });
    const visitors = UNUSED_VARS_RULE.create(proxy);
    const baseExit = visitors["Program:exit"];
    return {
      ...visitors,
      "Program:exit"(node) {
        if (Array.isArray(baseExit)) for (const fn of baseExit) fn(node);
        else if (typeof baseExit === "function") baseExit(node);
        for (const name of frozen) {
          if (stillUnused.has(name)) continue;
          context.report({
            node,
            message:
              `未使用绑定棘轮：'${name}' 已不再违规，请把它从 eslint.config.js 的 UNUSED_VARS_FROZEN 删掉（棘轮只许收紧）。`,
          });
        }
      },
    };
  },
};

export default tseslint.config(
  {
    name: "arch/ignores",
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      // 覆盖率产物（test:coverage 生成）：HTML 报表里的 assets/*.js 是第三方运行时，
      // 不是本仓源码；lint 它们只会产生噪声。
      "coverage/**",
      // W886: worker worktrees live at <repo>/.worktrees/<wid>. Each is a full
      // checkout of this repo; linting them from the main worktree would grade a
      // worker's in-progress code and duplicate every finding.
      ".worktrees/**",
      "reports/**",
      // 2026-10-04：tmp/ 与 results/ 是 **gitignored 的草稿/产物树**（见 .gitignore）。
      // 多 worker 同树时它们会被并发增删，而 `eslint .` 扫到「刚被删掉的文件」会
      // ENOENT 崩成 exit 2 ⇒ **假红**（实测：另一 worker 删 tmp/ 下的脚本时 eslint 正扫到它）。
      // lint 本来也不该扫它们 —— 它们不是本仓源码。
      "tmp/**",
      "results/**",
      // .dsh-tmp/ 是编排会话的草稿树（证据、克隆的参考仓），gitignored、非本仓源码，
      // 且与 tmp/ 同理：并发增删会让 eslint 扫到半途文件假红。
      ".dsh-tmp/**",
      "fixtures/**",
      "contracts/**",
      "**/*.json",
      "**/*.md",
    ],
  },
  {
    name: "arch/parser",
    files: SOURCE_GLOBS,
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2023,
      sourceType: "module",
    },
    linterOptions: {
      reportUnusedDisableDirectives: "warn",
    },
  },
  {
    name: "arch/unused-vars",
    files: SOURCE_GLOBS,
    plugins: {
      arch: {
        rules: {
          "unused-vars": frozenUnusedVarsRule,
          "unused-vars-stale": staleFrozenUnusedVarsRule,
        },
      },
    },
    rules: {
      "arch/unused-vars": ["error", UNUSED_VARS_OPTIONS],
      "arch/unused-vars-stale": [process.env.ARCH_STRICT === "1" ? "error" : "warn", UNUSED_VARS_OPTIONS],
    },
  },
  {
    name: "arch/size",
    files: SOURCE_GLOBS,
    rules: {
      "max-lines": lines(MAX_LINES),
      "max-lines-per-function": linesPerFunction(MAX_LINES_PER_FUNCTION),
      "max-depth": ["error", MAX_DEPTH],
      "max-params": ["error", MAX_PARAMS],
      "max-nested-callbacks": ["error", MAX_NESTED_CALLBACKS],
    },
  },
  {
    // 测试文件：单条用例是线性 arrange-act-assert，块上限放宽到 150 行；
    // 文件级 400 行、嵌套深度、参数个数仍然照旧（ARCHITECTURE.md §4.1）。
    name: "arch/size-tests",
    files: ["packages/*/src/**/*.test.ts", "apps/studio/src/**/*.test.ts", "tests/**/*.ts", "**/*.test-util.ts"],
    rules: {
      "max-lines-per-function": linesPerFunction(150),
    },
  },
  {
    name: "arch/import-boundary",
    files: SOURCE_GLOBS,
    rules: {
      "no-restricted-imports": ["error", { patterns: [DEEP_IMPORT, DEEP_RELATIVE] }],
    },
  },
  {
    // packages 不得依赖 apps（反向依赖）。
    name: "arch/no-packages-to-apps",
    files: ["packages/*/src/**/*.ts"],
    ignores: TEST_GLOBS,
    rules: {
      "no-restricted-imports": ["error", { patterns: boundaryPatterns({ noApps: true }) }],
    },
  },
  {
    // 第 1 层包之间不得互相依赖（同层横向依赖会制造隐式耦合）。
    name: "arch/tier1-no-peer-deps",
    files: TIER1.map((p) => `packages/${p}/src/**/*.ts`),
    ignores: TEST_GLOBS,
    rules: {
      "no-restricted-imports": ["error", { patterns: boundaryPatterns({ noApps: true, tier1: true }) }],
    },
  },
  {
    // core 是零依赖叶子：不得 import 任何其他 @celestea 包。
    // 注意：ESLint 的规则配置是「整块覆盖」，本块必须在通用/包级块之后，
    // 且自带 noApps 模式，否则会被前面的块覆盖掉。
    name: "arch/core-is-leaf",
    files: ["packages/core/src/**/*.ts"],
    ignores: TEST_GLOBS,
    rules: {
      "no-restricted-imports": ["error", { patterns: boundaryPatterns({ noApps: true, coreLeaf: true }) }],
    },
  },
  ...exceptionOverrides,
);
