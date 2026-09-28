// @vitest-environment node
/**
 * 文档可见性门禁（2026-09-28 的真实盲区）。
 *
 * ## 背景
 * `doc-conventions.test.ts` 的 `walkMd()` 判据是 `e.name.endsWith('.md')`，
 * 而 `docs/AGENT.local.md.example` 以 `.example` 结尾 ⇒ **永不被收录** ⇒
 * 它绕过了那 14 条断言的全部。全仓只有这一个这样的文件，所以盲区一直是静的。
 *
 * ## 本文件管两件事（都由 `tests/lib/doc-visibility.ts` 的共享判据驱动）
 * 1. **没有隐形文件**：`docs/` 下每个 markdown 必须落进
 *    `activeDocs` / `archiveDocs` / `DOC_EXEMPT` 三者之一。
 *    ★ 判据用**独立遍历**（`walkAllFiles`），不用 `walkMarkdownDocs` ——
 *      否则是循环论证（我实测过：把 walkMarkdownDocs 改回旧判据，用它自己写的断言全绿）。
 * 2. **豁免不腐烂**：豁免表每一项都真实存在，且数量被钉住（新增必须有人改数字）。
 *
 * ## 为什么这不是吹毛求疵
 * `AGENT.local.md.example` 的标题原本写着「AGENT.local.md — 本机事实（不入库）」、
 * 正文写着「本文件已被 .gitignore 忽略，永远不会提交」—— 而它【就是】被提交的那个
 * 文件。用户从 GitHub 点进去，据此认为「这文件不该上传」。措辞已改（见该文件），
 * 本门禁保证**将来不会再有文件靠「扫描器看不见」而绕过全部约束**。
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOC_EXEMPT,
  isMarkdownName,
  LOCAL_TEMPLATE,
  walkAllFiles,
  walkMarkdownDocs,
} from "./lib/doc-visibility.js";

const REPO = process.cwd();
const DOCS = join(REPO, "docs");
const ARCHIVE = join(DOCS, "archive");

const rel = (p: string): string => p.slice(DOCS.length + 1).split("/").join("/");
const isArchived = (p: string): boolean => rel(p).startsWith("archive/");

/** 与 `doc-conventions.test.ts` 的 `activeDocs()` 同口径。 */
function activeDocs(): string[] {
  return walkMarkdownDocs(DOCS).filter(
    (p) => !isArchived(p) && rel(p) !== "README.md" && !DOC_EXEMPT.has(rel(p)),
  );
}
function archiveDocs(): string[] {
  return walkMarkdownDocs(ARCHIVE);
}

describe("docs/ 可见性 · 没有文件能靠「扫描器看不见」而绕过门禁", () => {
  it("① 独立遍历：docs/ 下每个 markdown 都在 activeDocs/archiveDocs/豁免表里", () => {
    const seen = new Set([...activeDocs(), ...archiveDocs()].map(rel));
    seen.add("README.md"); // 总索引自身不参与 activeDocs
    const all = walkAllFiles(DOCS)
      .map(rel)
      .filter(isMarkdownName);
    const invisible = all.filter((r) => !seen.has(r) && !DOC_EXEMPT.has(r));
    expect(
      invisible,
      "这些 docs/ 下的 markdown 不在 activeDocs/archiveDocs 里，也没在 DOC_EXEMPT 里说明理由：\n" +
        invisible.join("\n"),
    ).toEqual([]);
  });

  it("② 豁免表每一项都真实存在（防豁免腐烂）", () => {
    const all = new Set(walkAllFiles(DOCS).map(rel));
    for (const r of DOC_EXEMPT) {
      expect(all.has(r), "DOC_EXEMPT 里的 " + r + " 不存在（豁免腐烂了，删掉它）").toBe(true);
    }
  });

  it("③ 豁免表不许悄悄变多（新增豁免必须有人改这个数字并说明理由）", () => {
    expect(DOC_EXEMPT.size, "豁免表变大了：新豁免要在 doc-visibility.ts 的注释里写明理由").toBe(2);
    expect(DOC_EXEMPT.has(LOCAL_TEMPLATE)).toBe(true);
  });

  it("④ 判据自检：walkMarkdownDocs 真的收后缀形态（防空集假绿）", () => {
    // 若正则写错，下面的断言会全绿但什么都没检查 —— 这正是本文件要防的那类失败。
    expect(isMarkdownName("a.md")).toBe(true);
    expect(isMarkdownName("a.md.example")).toBe(true);
    expect(isMarkdownName("a.MD.EXAMPLE")).toBe(true);
    // `.mdx` 不算：判据是「`.md` + 点后缀」，`.mdx` 的 `x` 前面没有点。
    // 本仓也没有 .mdx；若将来要收，改 isMarkdownName 并在此登记理由。
    expect(isMarkdownName("a.mdx")).toBe(false);
    expect(isMarkdownName("a.txt")).toBe(false);
    expect(isMarkdownName("a.md5")).toBe(false);
    // ★ 回归钉：这个文件必须被收进来（旧判据正是漏了它）。
    const walked = walkMarkdownDocs(DOCS).map(rel);
    expect(walked).toContain(LOCAL_TEMPLATE);
  });

  it("⑤ 独立遍历与 walkMarkdownDocs 的差集**只能**是豁免文件（防判据漂移）", () => {
    // 这条把「独立遍历」与「正式判据」绑在一起：两者若不一致，说明有一个漏了。
    const all = walkAllFiles(DOCS).map(rel);
    const walked = new Set(walkMarkdownDocs(DOCS).map(rel));
    const mdButNotWalked = all.filter((r) => isMarkdownName(r) && !walked.has(r));
    const walkedButNotMd = [...walked].filter((r) => !isMarkdownName(r));
    expect(mdButNotWalked, "这些 markdown 没被 walkMarkdownDocs 收进来").toEqual([]);
    expect(walkedButNotMd, "walkMarkdownDocs 收进了非 markdown").toEqual([]);
  });
});

describe("docs/ 可见性 · 本仓事实（防止门禁被改坏后无人察觉）", () => {
  it("⑥ 全仓确实存在这样一个「.md.<后缀>」文件，且它被看见", () => {
    // 这条记录的是**本仓的真实形状**：如果将来这个文件被删/改名，
    // 本断言会红 —— 那时请一并更新 DOC_EXEMPT 与这条断言，而不是删掉门禁。
    const suffixFiles = walkAllFiles(DOCS)
      .map(rel)
      .filter((r) => /\.md\.[a-z0-9]+$/i.test(r));
    expect(suffixFiles).toEqual([LOCAL_TEMPLATE]);
    expect(walkMarkdownDocs(DOCS).map(rel)).toContain(LOCAL_TEMPLATE);
  });
});
