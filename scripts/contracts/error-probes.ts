/**
 * EX-03 —— §2「只读错误分支」的数据表。
 *
 * 处方（docs/ARCHITECTURE.md:217）要求的「探针清单抽成数据表」：这张数组字面量
 * 就是原来内联在 main() 里的 errorProbes 声明，逐字段照搬，**一条探针都没增删**。
 * safeBecause 是「为什么这次调用不可能产生副作用」的源码依据，报告里原样引用。
 */
export interface ErrorProbe {
  id: string;
  method: string;
  path: string;
  body?: unknown;
  expectStatus: number;
  expectError: string;
  safeBecause: string;
}

export const ERROR_PROBES: ErrorProbe[] = [
  {
    id: "post_turn",
    method: "POST",
    path: "/api/turn",
    body: { input: "   " },
    expectStatus: 400,
    expectError: "input must not be empty",
    safeBecause: "src/main.rs:986-991 rejects a blank input BEFORE the busy slot is taken",
  },
  {
    id: "post_cancel",
    method: "POST",
    path: "/api/cancel",
    body: {},
    expectStatus: 200,
    expectError: "ok",
    safeBecause: "src/main.rs:1028-1037 only signals the watch channel; no state is written",
  },
  {
    id: "post_workspaces",
    method: "POST",
    path: "/api/workspaces",
    body: { path: "" },
    expectStatus: 400,
    expectError: "path must not be empty",
    safeBecause: "src/workspaces.rs:825-827 validates before WorkspaceRegistry::register",
  },
  {
    id: "post_provider_test",
    method: "POST",
    path: "/api/providers/test",
    body: { id: "__p0_probe__", base_url: "not-a-url", request_format: "chat_completions" },
    expectStatus: 400,
    expectError: "base_url",
    safeBecause: "src/providers.rs:729-735 builds an inline candidate and fails before run_probe; never persists",
  },
  {
    id: "post_prompts",
    method: "POST",
    path: "/api/prompts",
    body: { id: "bad id!", name: "probe" },
    expectStatus: 400,
    expectError: "prompt id must be 1-128 chars",
    safeBecause: "src/prompts.rs:748-751 validates the id before load_prompt_file/persist",
  },
  {
    id: "post_prompts_default",
    method: "POST",
    path: "/api/prompts/__p0_probe_missing__/default",
    body: {},
    expectStatus: 404,
    expectError: "unknown prompt",
    safeBecause: "src/prompts.rs:857-860 returns 404 before any persist",
  },
  {
    id: "get_session_messages",
    method: "GET",
    path: "/api/sessions/no-slash/messages",
    expectStatus: 400,
    expectError: "invalid session id",
    safeBecause: "parse_session_id rejects the id before any filesystem access",
  },
  {
    id: "get_fs_browse",
    method: "GET",
    path: "/api/fs/browse?path=relative-not-absolute",
    expectStatus: 400,
    expectError: "must be absolute",
    safeBecause: "pure read-only directory listing",
  },
  {
    id: "get_worker_status",
    method: "GET",
    path: "/api/worker/status?wid=__p0_probe_missing__",
    expectStatus: 200,
    expectError: "no worker",
    safeBecause: "read-only registry lookup",
  },
];
