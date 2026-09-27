/**
 * W9219 · shared 池的**平台策略**（唯一真源，配置与棘轮共用）。
 *
 * 为什么需要它：shared 池（`isolate:false`）的白名单证据**只在 Windows 采集**，
 * 而白名单里有 20 个文件带**条件跳过**（平台或能力探测，如 `it.skipIf(!posixShell)` /
 * `describe.skipIf(!POSIX_PROCESS_GROUPS)`；该计数由 w9219 棘轮按定义重算并钉住）。
 * 这些文件在 Windows 上的「6/6 通过」是**空洞的** —— 被跳过的用例根本没验证；
 * 而它们到了 Linux 会**真跑**。最危险的一个是 `apps/studio/src/main.test.ts` 的 SIGTERM 用例
 * （`describe.skipIf(!POSIX_PROCESS_GROUPS)`）：Windows 跳过、Linux 真跑，且本仓历史事故
 * 恰是「并发一改，该用例在 4 核 CI 上红」（见 vitest.config.ts 的 v1/v2 记录）。
 *
 * 所以：**shared 池只在 win32 启用**；其它平台一律返回空列表 ⇒ 全部文件走 isolated
 * （= 改动前行为）⇒ ubuntu CI 行为**零变化**。这是 fail-closed 方向（只降并发，不升）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 白名单证据的采集平台。证据换平台 ⇒ 必须重新采集，不得直接复用。 */
export const SHARED_POOL_PLATFORM = "win32";

const HERE = dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_PATH = join(HERE, "shared-pool-allowlist.json");

interface Allowlist {
  platform: string;
  shared: string[];
}

const ALLOWLIST = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) as Allowlist;

/** 白名单里记录的采集平台（供棘轮核对，防止「改了常量但 JSON 没改」）。 */
export const ALLOWLIST_PLATFORM = ALLOWLIST.platform;

/** shared 池在该平台是否启用。非 win32 一律 false（fail-closed）。 */
export function sharedPoolEnabled(platform: string): boolean {
  return platform === SHARED_POOL_PLATFORM;
}

/** shared 池在该平台应采集的文件：非 win32 恒为空 ⇒ 全部走 isolated。 */
export function sharedPoolFiles(platform: string): readonly string[] {
  return sharedPoolEnabled(platform) ? ALLOWLIST.shared : [];
}
