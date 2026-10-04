// @vitest-environment node
/**
 * 已更名的路径漂移守卫（W781：`frontend/` → `apps/web/`）。
 *
 * 为什么需要它：这类陈旧**没有任何门禁会报**。2026-10-04 实测 ——
 * `apps/web/FRONTEND-RULES.md`（前端验收标准）里还写着 `frontend/` 与 `pnpm build`，
 * 而**根 `pnpm build` 显式排除前端**（`--filter "!celestea-studio-frontend"`）⇒ 照它做等于没验证；
 * 同一批还有 7 处（bench 用法注释、`frontend/dist`、甚至一条错误消息里的"相对 frontend/ 的路径"）。
 *
 * **扫描面 = 现行口径**：`docs/**`（不含 archive）、`apps/web/**`、根 `*.md`。
 * **故意不扫**：`docs/archive/**`（历史本就该保留旧路径）、`contracts/**`（契约快照）、
 * `fixtures/**`（夹具）、`tests/**`（本文件自己就要引用这个字符串）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, "..");

/** 已更名的路径。加新条目时**必须**写清是哪一笔把它们搬走的。 */
const RENAMES = [
  { from: "frontend/", to: "apps/web/", why: "dd25af8 feat(w781) 前端并入 apps/web" },
];

const SCAN_ROOTS = ["docs", "apps/web", "README.md"];
const SKIP_DIRS = new Set(["archive", "node_modules", "dist", ".git", ".probe", "results"]);
const SCAN_EXT = /\.(md|ts|tsx|mjs|css|json)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); }
    else if (SCAN_EXT.test(e.name)) out.push(p);
  }
  return out;
}

describe("已更名路径的漂移守卫", () => {
  it("现行文档与前端源码里不再出现已更名的旧路径", () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      const abs = join(ROOT, root);
      if (!statSync(abs, { throwIfNoEntry: false })) continue;
      const files = statSync(abs).isFile() ? [abs] : walk(abs);
      for (const f of files) {
        const text = readFileSync(f, "utf8");
        for (const r of RENAMES) {
          if (text.includes(r.from)) {
            offenders.push(relative(ROOT, f).replaceAll("\\", "/") + " 含 " + r.from + "（应为 " + r.to + "，" + r.why + "）");
          }
        }
      }
    }
    expect(offenders, "旧路径写进现行文档后没人会报 —— 而照着它做事会什么都没验证").toEqual([]);
  });
});
