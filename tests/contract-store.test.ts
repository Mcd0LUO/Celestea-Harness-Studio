// @vitest-environment node
/**
 * W896 测试收敛：合并 2 个同环境、同夹具的分域测试文件。
 * 来源（纯搬运，用例与断言逐字未改）：
 *   - tests/contract-store.test.ts
 *   - tests/contract-doc-pointers.test.ts
 *
 * 为什么合并：这些小文件各只装 3–8 条用例，却各自付一次 fork 启动 + 环境构建
 * （实测 ~426ms/文件）。合并后仍由同一 vitest project 收集，覆盖不变。
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContractValidationError, FROZEN_COUNTS, createContractStore } from "@celestea/core";

/* ===== contract-store.test.ts ===== */
/**
 * W807 -- contract loading hardening.
 *
 * The loader used to re-read contracts/*.json on every call and compare it to
 * counts baked into the module at load time. A disk edit under a running process
 * therefore became a self-contradiction (W804: contracts/tools.json went 11 -> 12
 * on disk while production had 11 in memory; every compose 500'd until restart).
 * These tests pin the two halves of the fix on a THROWAWAY COPY of contracts/ --
 * the real files are never touched:
 *   1. after the first load the in-process view is a frozen snapshot: a later
 *      on-disk rewrite is visible on disk but does not change what the process
 *      sees, and the startup gate freezes the validated snapshot too;
 *   2. a file that disagrees with the frozen count makes the explicit startup
 *      gate (and the lazy first load) throw a readable ContractValidationError
 *      carrying file / expected / actual.
 */


const REAL_CONTRACTS = resolve(process.cwd(), "contracts");
const temps: string[] = [];

/** A writable copy of the real contracts directory, removed after each test. */
function copyContracts(): string {
  const dir = mkdtempSync(join(tmpdir(), "w807-contracts-"));
  cpSync(REAL_CONTRACTS, dir, { recursive: true });
  temps.push(dir);
  return dir;
}

/** Rewrite tools.json in the throwaway copy to a 3-tool variant (count 3). */
function driftTools(dir: string): string {
  const file = join(dir, "tools.json");
  const doc = JSON.parse(readFileSync(file, "utf8")) as { tools: unknown[]; count: number };
  writeFileSync(file, JSON.stringify({ ...doc, count: 3, tools: doc.tools.slice(0, 3) }));
  return file;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("W807 contract store", () => {
  it("reuses the first validated snapshot: a later disk rewrite cannot change it", () => {
    const dir = copyContracts();
    const store = createContractStore(dir);

    const first = store.loadTools();
    expect(first.tools).toHaveLength(FROZEN_COUNTS.tools);

    // Damage the throwaway copy and prove the damage is really on disk.
    const file = driftTools(dir);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { tools: unknown[]; count: number };
    expect(onDisk.count).toBe(3);
    expect(onDisk.tools).toHaveLength(3);

    // The process still sees the validated snapshot, not the new file.
    const second = store.loadTools();
    expect(second).toBe(first);
    expect(second.count).toBe(FROZEN_COUNTS.tools);
    expect(second.tools).toHaveLength(FROZEN_COUNTS.tools);
  });

  it("primes the cache at startup: verifyAtStartup freezes the on-disk snapshot", () => {
    const dir = copyContracts();
    const store = createContractStore(dir);
    expect(() => store.verifyAtStartup()).not.toThrow();

    driftTools(dir);

    expect(store.loadTools().tools).toHaveLength(FROZEN_COUNTS.tools);
  });

  it("fails fast on a drift, naming the file, the expected and the actual count", () => {
    const dir = copyContracts();
    const file = driftTools(dir);
    const store = createContractStore(dir);

    expect(() => store.verifyAtStartup()).toThrow(ContractValidationError);
    let message = "";
    try {
      store.verifyAtStartup();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("tools.json");
    expect(message).toContain("expected " + FROZEN_COUNTS.tools);
    expect(message).toContain("got 3");
    expect(message).toContain(file);
  });

  it("also fails fast on a lazy first load, not only at the startup gate", () => {
    const dir = copyContracts();
    driftTools(dir);
    const store = createContractStore(dir);
    expect(() => store.loadTools()).toThrow(ContractValidationError);
  });

  it("accepts the real repository contracts at the startup gate", () => {
    const store = createContractStore(REAL_CONTRACTS);
    expect(() => store.verifyAtStartup()).not.toThrow();
    expect(store.loadEndpoints().endpoints).toHaveLength(FROZEN_COUNTS.endpoints);
    expect(store.loadSse().events).toHaveLength(FROZEN_COUNTS.sseEvents);
  });
});

/**
 * W9213 -- the route snapshot's endpoint counts are DERIVED from the contract.
 *
 * Before this change the only thing pinning `tsApiEndpoints` / `tsMethodPathCombos`
 * was a literal in a test, so an endpoint could be added to the contract while the
 * snapshot kept the old number and the process would boot happily. The snapshot is
 * not a FROZEN file (it is read lazily), so this is checked on every read and at
 * the boot gate; these tests pin BOTH paths on a throwaway copy.
 */
describe("W9213 route snapshot counts are derived from the contract", () => {
  /** Bump the snapshot's declared count WITHOUT touching its arrays (the drift). */
  function driftSnapshotCount(dir: string, field: "tsApiEndpoints" | "tsMethodPathCombos"): string {
    const file = join(dir, "route-table.snapshot.json");
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
    writeFileSync(file, JSON.stringify({ ...doc, [field]: Number(doc[field]) + 1 }, null, 2) + "\n");
    return file;
  }

  it("accepts the real snapshot (the check is not vacuous)", () => {
    const store = createContractStore(REAL_CONTRACTS);
    const snap = store.loadRouteSnapshot();
    expect(snap.tsApiEndpoints).toBe(FROZEN_COUNTS.endpoints);
    expect(snap.tsMethodPathCombos).toBe(FROZEN_COUNTS.endpoints + snap.staticRoutes.length);
  });

  it("fails fast when tsApiEndpoints disagrees with the contract, naming the field", () => {
    const dir = copyContracts();
    const file = driftSnapshotCount(dir, "tsApiEndpoints");
    const store = createContractStore(dir);

    expect(() => store.loadRouteSnapshot()).toThrow(ContractValidationError);
    expect(() => store.verifyAtStartup()).toThrow(ContractValidationError);
    let message = "";
    try {
      store.verifyAtStartup();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("route-table.snapshot.json");
    expect(message).toContain("tsApiEndpoints");
    expect(message).toContain("expected " + FROZEN_COUNTS.endpoints);
    expect(message).toContain(file);
  });

  it("fails fast when tsMethodPathCombos disagrees with the contract + static routes", () => {
    const dir = copyContracts();
    driftSnapshotCount(dir, "tsMethodPathCombos");
    const store = createContractStore(dir);
    expect(() => store.loadRouteSnapshot()).toThrow(/tsMethodPathCombos/);
  });
});

/* ===== contract-doc-pointers.test.ts ===== */
/**
 * W893 — 契约里的**文档指针必须可达**。
 *
 * 起因（本次归档调研中查出的真 bug）：`contracts/endpoints.json` 有 9 处 `docRef`
 * 指向 `docs/feature-session-permissions.md`，而该文件**在 git 全历史里从未存在过**
 * （`git log --all` 零条记录）。原有门禁只断言 `docRef` 非空，不校验目标，
 * 于是这些指针可以一直烂着 —— 读契约的人按指针去查，只会得到一个不存在的路径。
 *
 * 这里把「指针可达」变成机械判定。指针有**两种合法形态**，不能混判：
 *   ① 路径 (path 或 path#anchor)：必须能解析到真实文件 / 真实标题；
 *   ② 章节引用（含 §，如 `docs/data-files.md §4.4`）：**不是路径**，是给人读的章节号，
 *      无法机械解析 —— 记为「不校验」，但**至少要求路径部分存在**。
 */

const ROOT = process.cwd();
const CONTRACTS = join(ROOT, 'contracts');

/**
 * 契约里承载「东西在哪」的字段名（与 contracts 现有用法一致）。
 *
 * B8-01 追加 `schemas`：`contracts/tools.json` 的 `source.schemas` 是**同一类**
 * 指针（一度写着 2026-09-11 已删除的 `/srv/celestea/engine-ref/crates/**`），
 * 只是它是「一句话里列多个路径」而不是「一个路径 + 散文」。放进同一个扫描器
 * 才能让两条指针共用一套判据；另起一个扫描器只会和这条慢慢长歪。
 *
 * 只收 `schemas`（复数）；`data-files/index.json` 的 `schema`（单数）是它自己的
 * JSON Schema 文档或文件名，不在这个语义里，刻意不收。
 */
const POINTER_FIELDS = ['docRef', 'sourceRef', 'doc', 'design', 'ref', 'schemas'] as const;

function jsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonFiles(p));
    else if (e.name.endsWith('.json')) out.push(p);
  }
  return out.sort();
}

interface Pointer { file: string; field: string; value: string }

function pointers(value: unknown, file: string, out: Pointer[] = []): Pointer[] {
  if (Array.isArray(value)) {
    for (const item of value) pointers(item, file, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if ((POINTER_FIELDS as readonly string[]).includes(key) && typeof child === 'string') {
        out.push({ file, field: key, value: child });
      } else {
        pointers(child, file, out);
      }
    }
  }
  return out;
}

function allPointers(): Pointer[] {
  const out: Pointer[] = [];
  for (const file of jsonFiles(CONTRACTS)) pointers(JSON.parse(readFileSync(file, 'utf8')), file.slice(ROOT.length + 1), out);
  return out;
}

/** GitHub 风格的标题 slug（与本仓 doc-conventions 的规则一致）。 */
function headings(file: string): Set<string> {
  const out = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    out.add(m[1]!.replace(/[*`_]/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-'));
  }
  return out;
}

describe('契约文档指针可达性', () => {
  it('每个指向 docs/ 的指针都解析到真实文件（章节引用只校验路径）', () => {
    const broken: string[] = [];
    for (const p of allPointers()) {
      if (!p.value.startsWith('docs/')) continue;
      // 形态 ②：`path §N` 是章节引用。路径部分 = 去掉 `#anchor`、再截到 § 之前。
      const pathPart = p.value.split('#')[0]!.split('§')[0]!.trim();
      if (!existsSync(join(ROOT, pathPart))) {
        broken.push(p.file + ' ' + p.field + ' -> ' + p.value + '  [文件不存在]');
      }
    }
    expect(broken, '契约指向了不存在的文档（读契约的人会查不到）').toEqual([]);
  });

  it('带 #anchor 的指针命中目标标题（不是只写了个大概）', () => {
    const broken: string[] = [];
    for (const p of allPointers()) {
      if (!p.value.startsWith('docs/') || !p.value.includes('#')) continue;
      const [pathPart, anchor] = p.value.split('#');
      const full = join(ROOT, pathPart!);
      if (!existsSync(full)) {
        broken.push(p.file + ' ' + p.field + ' -> ' + p.value + '  [文件不存在]');
        continue;
      }
      if (!headings(full).has(anchor!.toLowerCase())) {
        broken.push(p.file + ' ' + p.field + ' -> ' + p.value + '  [锚点不存在]');
      }
    }
    expect(broken, '锚点写错 = 指针等于没有').toEqual([]);
  });

  /**
   * B8-01 —— `sourceRef` 必须解析到**现役**仓内文件。
   *
   * 为什么单列一条：上面两条指针门禁都带 `p.value.startsWith('docs/')` 过滤，
   * 所以 `sourceRef`（以及任何 `packages/`、`apps/` 指针）从来没被查过。实测
   * 后果是 `contracts/tools.json` 里 10 条 `sourceRef` 全部指向 **2026-09-11 已删除**
   * 的 `crates/*.rs`，而四条门禁全绿——读契约的人按指针去查只会得到一个不存在的路径。
   *
   * 判据刻意分成两档（与本文件既有的「docs 指针」门禁分工）：
   *   ① **仓内指针**（首 token 以 `docs/`、`packages/`、`apps/`、`contracts/` 开头）：
   *      必须解析到真实文件。这是本条的主判据。
   *   ② `crates/**` = 已退役的参照实现，**不是**仓内指针：不能判它「坏」，
   *      但它也不该再被当成可解析入口——若哪天有人把它写回来，这里要求带
   *      `retired-engine/` 前缀（仓内已有该写法先例：packages/llm/README.md:3），
   *      让「这是历史引用」成为**显式**事实，而不是靠读者自己推断。
   *
   * 只取**首 token**作为路径：现有 `sourceRef` 的形态是
   * `path (provenance 散文)`，散文部分不可机械解析（同上：形态 ② 的取舍）。
   * 首 token 本身必须是纯路径——这正是 B8-01 顺带修掉的第 11 处
   * （`"W783: packages/tools/src/tools/ask-user.ts"` 把工号前缀写进了首 token，
   * 于是任何「首 token 当路径」的扫描都读不出它指向哪）。
   */
  it('sourceRef 的首 token 是仓内可解析路径（退役的 crates 引用必须带 retired-engine/ 前缀）', () => {
    const IN_REPO = /^(docs|packages|apps|contracts|scripts|tests)\//;
    const RETIRED = /^(crates|src|retired-engine)\//;
    /** A glob tail (`*.ts`) is checked against the directory that carries it. */
    const isPathLike = (tok: string): boolean => IN_REPO.test(tok) || RETIRED.test(tok);
    const broken: string[] = [];
    const retiredUnmarked: string[] = [];
    let checked = 0;

    /**
     * `sourceRef` is one path + prose ("path (W123; note)"); `schemas` is a
     * *sentence* listing several of them ("a/*.ts (...) + b.ts + c.ts; ...").
     * Both are reduced to their path-like tokens, so one judgement serves both
     * rather than growing a second scanner that would drift from this one.
     *
     * A token is path-like if it starts with a known repo root OR carries a
     * source-file suffix (`*.ts`/`*.rs`/`*.mjs`…); the suffix test is what
     * picks `crates/tools/src/builtin.rs:217-230` out of a retired note while
     * ignoring ordinary prose. Parentheticals are dropped first so the
     * "was crates/…" history note is not judged as a live pointer.
     */
    function pathTokens(value: string): string[] {
      const prose = value.replace(/\([^)]*\)/g, ' ');
      return prose
        .split(/\s+/)
        // Strip punctuation from BOTH ends: prose here is a SENTENCE ("a.ts; b.ts."),
        // so the separator lands on the tail ("tool.ts;"), not just the head. Only
        // leading was stripped before, which judged "tool.ts;" a missing file and
        // made a correct contract look broken.
        .map((t) => t.replace(/^[;,\s]+|[;,\s]+$/g, '').replace(/[.,;:]+$/, '').split('#')[0]!)
        .filter((t) => t !== '' && isPathLike(t) && /[./*]/.test(t));
    }

    /** A glob (`dir/*.ts`) resolves if the DIRECTORY carrying it exists. */
    function resolves(pathPart: string): boolean {
      const base = pathPart.replace(/[\\/]\*\.[A-Za-z0-9]+$/, '');
      return existsSync(join(ROOT, base === '' ? '.' : base));
    }

    for (const p of allPointers()) {
      if (p.field !== 'sourceRef' && p.field !== 'schemas') continue;
      for (const pathPart of pathTokens(p.value)) {
        if (IN_REPO.test(pathPart)) {
          checked++;
          if (!resolves(pathPart)) {
            broken.push(p.file + ' ' + p.field + ' -> ' + p.value + '  [不是真实文件]');
          }
        } else if (RETIRED.test(pathPart) && !pathPart.startsWith('retired-engine/')) {
          retiredUnmarked.push(p.file + ' ' + p.field + ' -> ' + p.value + '  [退役引用未标 retired-engine/]');
        }
      }
    }

    expect(broken, '指针指向不存在的仓内文件（读契约的人会查不到）').toEqual([]);
    expect(retiredUnmarked, 'crates/ 是 2026-09-11 已删除的参照实现；引用它就得标 retired-engine/').toEqual([]);
    // 空清单 = 扫描器坏了（门禁空转），与本文件既有断言同一手法
    expect(checked, '扫描器必须找到仓内指针（否则本条是空转的）').toBeGreaterThan(0);
  });

  it('没有指向 git 历史里从未存在过的文件（这正是本次查出的 bug 形态）', () => {
    // 具体化那条 bug：路径存在与否必须用工作区判定；历史判定交给 review。
    // 这里只需保证上面的清单不为空且没坏 —— 空清单说明扫描器坏了（门禁空转）。
    const docs = allPointers().filter((p) => p.value.startsWith('docs/'));
    expect(docs.length, '扫描器必须找到契约里的 docs 指针（否则门禁是空转的）').toBeGreaterThan(0);
  });
});