/**
 * W9269 (docs/feature-sandbox-comparison.md §3.2 gap / §4 P0) — the MANDATORY
 * WRITE DENY LIST (the `DANGEROUS_FILES` equivalent).
 *
 * ## The gap this closes
 *
 * Before this module, the path guard answered ONE question about a write: "is
 * the target inside a writable root?" Every widening mechanism in the system
 * (session grants, a preset, `allPaths`, `CELESTEA_TOOL_ROOTS`) can enlarge the
 * set of writable roots — and none of them had a floor. So a single
 * `write_file(join(home, ".bashrc"))` that had been granted the home directory
 * silently rewrote the user's shell startup file: the agent writes it once, the
 * USER executes it later. That is an execution surface, not a data file, and it
 * is the exact "意外防护" (accident protection) floor this repo was missing.
 *
 * ## Why the list is NOT a root list
 *
 * A root list is a *whitelist*: it says where you MAY write, and every
 * widening knob is a way to make it bigger. This list is a *floor*: it says
 * where you may NEVER write, and no widening knob may shrink it. The two
 * compose, they are not alternatives — which is precisely why this list is
 * evaluated LAST inside `PathGuardPolicy.checkWrite`, after (and therefore
 * regardless of) every allow decision. See the wiring comment there.
 *
 * ## WRITE only, by construction
 *
 * The list is consulted from `checkWrite` and from nowhere else. `checkRead`
 * cannot reach it, so reading `.gitconfig` or `~/.ripgreprc` stays a legal
 * diagnostic — that is the whole reason the list is a write-deny list and not a
 * blanket "forbidden paths" list. Denying the reads would break the "look at
 * my git config" task to protect nothing: reading a file does not execute it.
 *
 * ## The three shapes
 *
 * - exact FILE NAMES (`.bashrc`, `.gitconfig`, …): the FINAL component of the
 *   write target, compared by the platform's basename rules;
 * - single-component DIRECTORY prefixes (`.vscode`, `.idea`): any path
 *   component equal to the prefix, plus everything below it. The component test
 *   (not a string prefix) is what keeps `.vscode-legacy/` and `my.vscode/`
 *   writable;
 * - a MULTI-component directory prefix (`.claude/commands`): the consecutive
 *   components `.claude` then `commands` at any depth, plus everything below.
 *   A project's `.claude/` settings are ordinary repo content, so the deny is
 *   deliberately narrower than "`.claude`".
 *
 * ## B5-02 · the Windows + credential half
 *
 * The original list was POSIX-flavoured: it named the shell startup files whose
 * only real-world instance is a dotfile in $HOME. That left two whole classes of
 * execution/credential surface unwritten, and this repo's PRIMARY deployment
 * platform is Windows:
 *
 *   1. **PowerShell profiles.** A profile is the exact analogue of `.bashrc`:
 *      writing one plants code that runs at the NEXT session. On Windows it lives
 *      at three documented paths (AllHosts / CurrentUser / CurrentHost), all
 *      sharing the file NAME — so the win32 list matches the name and covers
 *      every location and any depth at once. It is **win32-only** so a Linux
 *      deployment is not handed a rule about a file it cannot have.
 *
 *   2. **Credential stores.** `.aws/`, `.gnupg/`, `.docker/config.json`,
 *      `.kube/config`, `.npmrc`, `.pypirc`, `.netrc` are cross-platform and
 *      are listed as such. These are not "configuration the user reads" — they
 *      are secrets the user's own tools authenticate with, so an agent edit
 *      silently repoints the next push/pull/docker/kubectl.
 *
 * Platform is STILL a parameter: only the profile names branch on it, and the
 * case/separator rules below are unchanged.
 *
 * ## Platform is a PARAMETER
 *
 * `platform` is injectable (AGENT.md §8 / W885 / W9110 precedent) so the win32
 * case is provable on a Linux CI runner and the POSIX case on Windows. The two
 * differ in exactly the way that makes this module a security control at all:
 *
 * - **case**: Windows file names are case-INSENSITIVE, so `.BASHRC` and
 *   `.bashrc` are THE SAME FILE there; on POSIX they are two different files
 *   and folding case would deny writes the user never considered dangerous.
 *   Therefore win32 folds, POSIX does not.
 * - **separator**: win32 accepts `/` and `\\` interchangeably, so the
 *   comparison normalises to `\\`; POSIX segments on `/` only.
 *
 * A test that ran only on the host platform would pass everywhere and protect
 * nothing, so `denyListMatch` takes the platform explicitly.
 */
import { GUARD_ERROR_PREFIX, contractError } from "../errors.js";
import { isWindows, pathApi } from "../platform/paths.js";
import type { ToolDecision } from "@celestea/core";

/**
 * Stable contract code for a write-deny-list refusal.
 *
 * A NAMED code, not a bare string and not a silent skip: a caller can branch on
 * `code=path_dangerous_write` and tell "this path is never writable, whatever
 * your grants say" apart from `code=path_forbidden` ("this path is outside your
 * roots right now") — two decisions a caller genuinely needs to tell apart, and
 * the first one is not fixed by widening anything.
 */
export const DANGEROUS_WRITE_CODE = "path_dangerous_write";

/**
 * Exact FILE NAMES that may never be the target of a write.
 *
 * Ordered as the doc lists them (§4 P0) so the contract error and this list
 * read the same way in a diff. The whole set is dotfiles: shell startup files
 * (`.bashrc`, `.bash_profile`, `.zshrc`, `.profile`) plus the config
 * surfaces that change what the user's own tools execute or resolve
 * (`.gitconfig`, `.gitmodules`, `.mcp.json`, `.ripgreprc`).
 */
export const DANGEROUS_WRITE_FILES: readonly string[] = Object.freeze([
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".profile",
  ".gitconfig",
  ".gitmodules",
  ".mcp.json",
  ".ripgreprc",
]);

/**
 * Single-component DIRECTORY prefixes (matched on a whole path component, at
 * any depth, together with everything below them).
 */
export const DANGEROUS_WRITE_DIRS: readonly string[] = Object.freeze([".vscode", ".idea"]);

/**
 * Multi-component DIRECTORY prefixes, relative and matched at any depth: the
 * write is refused when these components appear consecutively in the path. The
 * doc's §4 P0 lists exactly one of these: `.claude/commands`.
 */
export const DANGEROUS_WRITE_DIR_PREFIXES: readonly (readonly string[])[] = Object.freeze([
  Object.freeze([".claude", "commands"]),
]);

/**
 * B5-02 · WINDOWS 启动文件名（单组件，匹配**最终组件**）。
 *
 * 为什么单列一份而不是并进 [DANGEROUS_WRITE_FILES]：那一份是**跨平台**的，
 * POSIX 也认（`~/.bashrc` 在 Linux 上同样是一个执行面）。而 PowerShell
 * profile 只在 Windows 上有意义，混进去会让 Linux 部署凭空多出一条拒写。
 *
 * 名单的立论与 shell 启动文件同源：写入一个 profile = 往**下一次会话**里塞
 * 自己的代码，用户执行它时才生效 —— 那是执行面，不是数据文件。
 *
 * 三种 profile 路径都覆盖：`$PROFILE` 依次是
 *   AllHosts    Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1
 *   CurrentUser Documents\PowerShell\Microsoft.PowerShell_profile.ps1
 *   CurrentHost 存在时与 CurrentUser 相同；
 * 而 PS 5.1 的 AllHosts 固定在 AppData\Roaming\Microsoft\Windows\PowerShell\。
 * 只按**文件名**匹配（三者同名），所以三种位置一次覆盖，且任意深度都命中。
 *
 * `profile.ps1` 也列入：它是 ISE 与部分部署的约定名。
 */
export const DANGEROUS_WRITE_FILES_WIN32: readonly string[] = Object.freeze([
  "Microsoft.PowerShell_profile.ps1",
  "profile.ps1",
]);

/**
 * B5-02 · 凭据目录前缀（任意深度的**连续组件**序列）。
 *
 * 与 [DANGEROUS_WRITE_DIRS] 的区别是「跨平台」：`.aws`/`.gnupg` 在 Linux 上
 * 同样是凭据面，所以这一份**不分平台**。
 *
 * 挡的是「读回来只当数据、用时却是凭据」的那类文件：`credentials` 里是明文
 * 长期密钥；`config.json` 决定 registry 从哪拉镜像；`config`(kube) 是集群
 * 凭据。agent 改这些 = 把用户下一次 push/pull/docker/kubectl 的身份换掉。
 *
 * 多组件序列（而不是单组件）是为了**不误伤**：仓库里若有 `docs/aws/` 这样的
 * 普通目录不该被拒，所以列成 `[".aws"]` 只在**首层就是** `.aws` 时命中 ——
 * 这正是「任意深度、连续组件」规则的语义：`a/.aws/x` 命中，`docs/aws/x` 不命中。
 */
export const DANGEROUS_WRITE_DIR_PREFIXES_CREDENTIAL: readonly (readonly string[])[] = Object.freeze([
  Object.freeze([".aws"]),
  Object.freeze([".gnupg"]),
  Object.freeze([".docker", "config.json"]),
  Object.freeze([".kube", "config"]),
  Object.freeze([".azure"]),
  Object.freeze([".gcloud"]),
  Object.freeze([".config", "gcloud"]),
]);

/**
 * B5-02 · 凭据**文件**名（最终组件，跨平台）。
 *
 * 同样是「写进去的是凭据」而不是「读出来是配置」：`.npmrc` 可以钉死 registry
 * 与 `//registry.npmjs.org/:_authToken`，`.pypirc` 是 PyPI 上传凭据，
 * `.netrc`/ `_netrc` 是 curl/wget 的通用凭据文件。
 */
export const DANGEROUS_WRITE_FILES_CREDENTIAL: readonly string[] = Object.freeze([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".pypirc.ini",
]);

/** What a write target matched, and under which rule. */
export interface DenyListMatch {
  /** The deny-list entry that matched, in its documented spelling. */
  readonly entry: string;
  /** Which rule matched. */
  readonly shape: "file" | "dir" | "dir-prefix";
}

/**
 * The win32 spelling used for COMPARISON only: lowercase + `\\` separators.
 *
 * Same reasoning as `foldWin32` in `paths.ts` — and the same rule about never
 * building a path from it: only the two sides of a comparison see this.
 */
function foldForCompare(segment: string, platform: string): string {
  if (!isWindows(platform)) return segment;
  return segment.toLowerCase().replace(/\//g, "\\");
}

/** Split an absolute path into its components under the platform's separator rules. */
function splitSegments(normalized: string, platform: string): string[] {
  return normalized
    .split(isWindows(platform) ? /[\\/]+/ : "/")
    .filter((segment) => segment !== "");
}

/**
 * The documented spellings, joined for the denial message.
 *
 * B5-02: the message now also names the credential + Windows entries, because a
 * refusal a user cannot connect to the LIST they hit is a refusal they will read
 * as a bug (and route around). The list is per-platform at MATCH time, but the
 * message states every rule that COULD have fired here — being explicit is
 * cheaper than a user asking "why is .aws/credentials special?".
 */
const LIST_TEXT = [
  DANGEROUS_WRITE_FILES.join(", "),
  DANGEROUS_WRITE_DIRS.join(", "),
  ...DANGEROUS_WRITE_DIR_PREFIXES.map((parts) => parts.join("/")),
  DANGEROUS_WRITE_FILES_CREDENTIAL.join(", "),
  ...DANGEROUS_WRITE_DIR_PREFIXES_CREDENTIAL.map((parts) => parts.join("/")),
  DANGEROUS_WRITE_FILES_WIN32.join(", ") + " (windows)",
].join(", ");

/**
 * Which deny-list entry (if any) a write target hits.
 *
 * `target` must already be ABSOLUTE and normalized (the guard hands it the
 * canonical write target); this function does no fs access and is therefore
 * safe to call on a path that does not exist yet — a write is judged by where
 * the bytes WOULD land.
 *
 * Returns `null` when the target is not on the list, so a caller can use it
 * directly as an "is this dangerous?" test.
 */
export function denyListMatch(target: string, platform: string = process.platform): DenyListMatch | null {
  const api = pathApi(platform);
  // `normalize` first so `a/.vscode/../ok.txt` is judged on where the write
  // actually lands. (The guard also canonicalizes through realpath, but the
  // deny must not depend on that: a path inside a symlink-free but lexically
  // dirty argument has to be judged the same way on every host.)
  const segments = splitSegments(api.normalize(target), platform);
  if (segments.length === 0) return null;
  const folded = segments.map((segment) => foldForCompare(segment, platform));

  // ① the final component as an exact file name.
  //
  // B5-02: the list is the union of the cross-platform names, the credential
  // names, and — **win32 only** — the PowerShell profile names. The platform
  // check lives HERE rather than in the array so the exported constants stay
  // declarative: one list, one matcher, and a Linux host can never deny a
  // PowerShell path that does not exist on it.
  const lastFolded = folded[folded.length - 1] as string;
  const fileLists: readonly (readonly string[])[] = isWindows(platform)
    ? [DANGEROUS_WRITE_FILES, DANGEROUS_WRITE_FILES_CREDENTIAL, DANGEROUS_WRITE_FILES_WIN32]
    : [DANGEROUS_WRITE_FILES, DANGEROUS_WRITE_FILES_CREDENTIAL];
  for (const file of fileLists.flat()) {
    if (lastFolded === foldForCompare(file, platform)) return { entry: file, shape: "file" };
  }

  // ② a single-component directory prefix anywhere in the path (the target may
  //    BE the directory: a tool that creates `<ws>/.vscode` is refused too).
  for (const dir of DANGEROUS_WRITE_DIRS) {
    const dirFolded = foldForCompare(dir, platform);
    if (folded.includes(dirFolded)) return { entry: dir, shape: "dir" };
  }

  // ③ a multi-component directory prefix appearing consecutively at any depth.
  //
  // B5-02: the credential prefixes ([".aws"], [".docker","config.json"], …) join
  // here. They are cross-platform, so there is no platform branch — the
  // consecutive-component rule is exactly the semantics ".aws is only special
  // when it IS the .aws directory", which keeps docs/aws/ writable.
  const prefixes = [...DANGEROUS_WRITE_DIR_PREFIXES, ...DANGEROUS_WRITE_DIR_PREFIXES_CREDENTIAL];
  for (const parts of prefixes) {
    const partsFolded = parts.map((part) => foldForCompare(part, platform));
    for (let start = 0; start + partsFolded.length <= folded.length; start += 1) {
      let hit = true;
      for (let offset = 0; offset < partsFolded.length; offset += 1) {
        if (folded[start + offset] !== partsFolded[offset]) {
          hit = false;
          break;
        }
      }
      if (hit) return { entry: parts.join("/"), shape: "dir-prefix" };
    }
  }
  return null;
}

/**
 * The structured refusal for a deny-listed write target.
 *
 * Rendered through [contractError] with the guard family prefix, exactly like
 * `path-guard.ts`'s own denials — so the one-line contract stays
 * `toolguard: code=<code> msg="…"` and a consumer can still classify it with
 * `denialFamily()` / `errorCode()` (errors.ts, W1483).
 */
export function dangerousWriteDecision(target: string, match: DenyListMatch, platform: string = process.platform): ToolDecision {
  const rule =
    match.shape === "file"
      ? `file name '${match.entry}'`
      : match.shape === "dir"
        ? `directory prefix '${match.entry}'`
        : `directory prefix '${match.entry}'`;
  const reason = contractError(
    GUARD_ERROR_PREFIX,
    DANGEROUS_WRITE_CODE,
    `write path '${target}' is on the mandatory deny list (${rule}); no grant, preset, allPaths or CELESTEA_TOOL_ROOTS can make it writable. Deny list: ${LIST_TEXT}. Reads are not affected. (platform=${platform})`,
  );
  return { kind: "deny", reason };
}

/**
 * true when `target` may not be written, under the deny list alone.
 *
 * A tiny convenience over `denyListMatch` for callers that only need the
 * predicate (tests, diagnostics).
 */
export function isDangerousWrite(target: string, platform: string = process.platform): boolean {
  return denyListMatch(target, platform) !== null;
}
