/**
 * 「docs/ 下哪些 markdown 文件是**看得见**的」—— 供 `tests/doc-conventions.test.ts`
 * 与 `tests/w2061-doc-visibility.test.ts` 共用。
 *
 * ## 为什么单独一个文件（2026-09-28 的真实盲区）
 *
 * `doc-conventions.test.ts` 的 `walkMd()` 判据原是 `e.name.endsWith('.md')`，
 * 而 `docs/AGENT.local.md.example` 以 `.example` 结尾 ⇒ **永不被收录** ⇒
 * 它绕过了那 14 条断言的全部（本机身份 / 绝对路径 / 链接可达 / 700 行上限 …）。
 * 全仓只有这一个这样的文件，所以这个盲区**一直是静的**。
 *
 * 它同时暴露了第二个问题：豁免原来是「恰好没被扫到」而不是一个**看得见的决定**。
 * 所以本模块把两件事显式化：
 *   · `walkMarkdownDocs()` 收录 `.md` 与 `.md.<后缀>`（如 `.md.example`）；
 *   · `DOC_EXEMPT` 列出**允许**不被当作「现行文档」的路径，并附理由。
 *
 * 为什么要判 `isTracked()` 而不是「文件存在」：`AGENT.local.md`（gitignore 的本机
 * 文件，★本该装满本机事实）与 `AGENT.local.md.example`（入库模板）都在豁免表里，
 * 但只有后者该受「机器事实」约束。**「会不会被提交」只有 git 索引知道。**
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** 本机文件：由模板复制而来，gitignore，永不提交。 */
export const LOCAL_ONLY = "AGENT.local.md";

/** 上面那个文件的**模板**：它【是】入库的（否则别人 clone 后没有可复制的模板）。 */
export const LOCAL_TEMPLATE = "AGENT.local.md.example";

/**
 * 允许不被 `activeDocs()` 收录的路径（相对 `docs/`），**每一项都要有理由**。
 *
 * 显式列出来，是为了让「豁免」是一个看得见的决定 —— 而不是「恰好没被扫到」。
 * 条目数量由 `tests/w2061-doc-visibility.test.ts` 钉住：新增豁免必须有人改那个数字。
 */
export const DOC_EXEMPT: ReadonlySet<string> = new Set([LOCAL_ONLY, LOCAL_TEMPLATE]);

/** 是否 `docs/` 下的 markdown（含 `.md.<后缀>` 形态，如 `.md.example`）。 */
export function isMarkdownName(name: string): boolean {
  return /\.md(\.[a-z0-9]+)?$/i.test(name);
}

/**
 * 递归收集 `dir` 下的 markdown 文件（`.md` 与 `.md.<后缀>`）。
 *
 * ★ 与旧判据的差别就是多认了后缀形态 —— 那正是让 `AGENT.local.md.example` 隐形的原因。
 */
export function walkMarkdownDocs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMarkdownDocs(p));
    else if (isMarkdownName(e.name)) out.push(p);
  }
  return out.sort();
}

/**
 * 递归收集 `dir` 下**全部**文件（不预设后缀）。
 *
 * ★ 存在的意义是**独立性**：用它来验证「walkMarkdownDocs 没有漏」，
 *   否则就是循环论证（我实测过：把 walkMarkdownDocs 改回旧判据，
 *   用 walkMarkdownDocs 自己写的断言依然全绿 —— 因为两边一起缩小了）。
 */
export function walkAllFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkAllFiles(p));
    else out.push(p);
  }
  return out.sort();
}

/** 相对 `base` 的 POSIX 风格路径。 */
export function relTo(base: string, p: string): string {
  return relative(base, p).split(sep).join("/");
}

/** 该路径是否**在 git 索引里**（= 会被提交）。判据是索引，不是「文件存在」。 */
export function isTracked(repo: string, relPath: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", relPath], {
      cwd: repo,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true; // 命中即 0 退出；未命中会抛
  } catch {
    return false;
  }
}
