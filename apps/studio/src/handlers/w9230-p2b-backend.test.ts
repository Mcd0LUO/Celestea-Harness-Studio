/**
 * W9230 · P2批次2-后端 —— W9206 未修清单里可机械复现部分的回归测试。
 *
 * 每条用例对应报告中的一条发现，且都**先在缺陷形态下红过一次**（变异负控制
 * 记录在 results/W9230-P2批次2-后端.md §4）。覆盖：
 *   W9206-12  isLoopbackBind 字符串前缀绕过（bind 安全门）
 *   W9206-10  登录限流 MAX_KEYS 溢出 hits.clear() 重置锁定
 *   W9206-15  loadAuthSecret 读路径不收紧权限 / 不限制长度
 *   W9206-08  context_window / max_output_tokens 负数与 0
 *   W9206-22  0 字节 registry 被读成空表并固化
 *   W9206-23  session.json 非原子写
 *   W9206-21  disabled 列表无条数上限
 *   W9206-43  timeout_ms 裸 typeof（Infinity）
 *   W9206-44  非字符串 api_key 被静默当作「保留旧密钥」
 *   W9206-45  /api/status 的 isBusy 用未规范化 id
 *   W9206-47  终端 409 文案与冻结契约不一致
 *   W9206-39  /api/fs/list 先 lstat 全部再截断
 */

import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertBindIsSafe, InsecureBindError, isLoopbackBind } from "../auth/api-token.js";
import { createFailureLimiter } from "../auth/rate-limit.js";
import { AUTH_SECRET_BYTES, loadAuthSecret } from "../auth/token.js";
import { MAX_SESSION_DISABLED_TOOLS, normalizeDisabledTools } from "../store/session-tools.js";
import { readSessionMeta, writeSessionMeta } from "../store/session-meta.js";
import { FILE_MODES_MEANINGFUL } from "@celestea/tools";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "../harness.test-util.js";
import type { RuntimeAdapter } from "../runtime-adapter.js";
import { createFakeRuntimeAdapter } from "../fake-runtime-adapter.js";

const roots: string[] = [];
const harnesses: StudioHarness[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "w9230-"));
  roots.push(dir);
  return dir;
}

function make(opts: Parameters<typeof makeHarness>[0] = {}): StudioHarness {
  const h = makeHarness(opts);
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

// ---------------------------------------------------------------- W9206-12

describe("W9206-12: isLoopbackBind 只认真正的 127.0.0.0/8 地址", () => {
  it("接受环回地址（含 127.0.0.0/8 与 IPv4-mapped IPv6）", () => {
    for (const bind of ["127.0.0.1", "127.0.0.5", "127.0.0.1:3777", "localhost", "::1", "[::1]:3777", "::ffff:127.0.0.1"]) {
      expect(isLoopbackBind(bind), bind).toBe(true);
    }
  });

  it("拒绝以 '127.' 开头但并非地址的字符串（前缀绕过的正例）", () => {
    for (const bind of ["127.evil.com", "127.0.0.1.evil.com", "127.0.0.1.5", "127.300.0.1", "127.0.0.1x", "::ffff:127.evil.com"]) {
      expect(isLoopbackBind(bind), bind).toBe(false);
    }
  });

  it("fail-closed：非环回 bind 无 token 一律 InsecureBindError", () => {
    for (const bind of ["127.evil.com", "127.0.0.1.evil.com", "0.0.0.0", "::ffff:127.evil.com"]) {
      expect(() => assertBindIsSafe(bind, null), bind).toThrow(InsecureBindError);
    }
    // 保留原有意图：127.0.0.0/8 内仍免 token。
    expect(() => assertBindIsSafe("127.0.0.5", null)).not.toThrow();
  });
});

// ---------------------------------------------------------------- W9206-09

describe("W9206-09: X-Real-IP 只在环回对端时才被信任", () => {
  /**
   * 一次登录失败：对端地址固定，X-Real-IP 与用户名每轮都不同。
   *
   * 用户名必须每轮不同，否则 `u:<name>` 桶会先于 `ip:` 桶填满 —— 那样
   * 「第 6 次 429」就无法归因到 ip 桶，用例会假绿。
   */
  async function attempt(h: StudioHarness, peer: string, round: number): Promise<number> {
    const res = await h.app.request(
      "/auth/login",
      { method: "POST", headers: { "content-type": "application/json", "x-real-ip": `203.0.113.${round}` }, body: JSON.stringify({ username: `u${round}`, password: "nope" }) },
      { incoming: { socket: { remoteAddress: peer } } },
    );
    return res.status;
  }

  it("非环回对端换 X-Real-IP 无法绕过 ip 桶（第 6 次 429）", async () => {
    const h = make({ session: { name: "s1", log: "" } });
    // 对端 10.9.9.9（非环回）：伪造的 X-Real-IP 必须被忽略，6 次都落进同一个
    // ip:10.9.9.9 桶 ⇒ 第 6 次 429。缺陷形态（无条件信任）下每轮都是新桶，
    // ip 桶永远只有 1 次 ⇒ 永不 429（这正是原审计的实测结论）。
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push(await attempt(h, "10.9.9.9", i));
    expect(codes.slice(0, 5).every((c) => c !== 429)).toBe(true);
    expect(codes[5]).toBe(429);
  });

  it("环回对端（nginx 代理）仍然信任 X-Real-IP（正向对照）", async () => {
    const h = make({ session: { name: "s1", log: "" } });
    // 对端 127.0.0.1 = 文档化的 nginx 前置：此时按真实客户端 IP 分桶，
    // 每轮换一个 X-Real-IP ⇒ 没有桶达到阈值 ⇒ 全程无 429（保留该头的目的）。
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push(await attempt(h, "127.0.0.1", i));
    expect(codes).not.toContain(429);
  });
});

// ---------------------------------------------------------------- W9206-10

describe("W9206-10: 限流表满时不重置已有锁定", () => {
  it("打满一个账号后再注入 4096 个不同 key，该账号仍被锁定", () => {
    const limiter = createFailureLimiter({ now: () => 1_000_000, windowMs: 60_000, maxFailures: 5 });
    for (let i = 0; i < 5; i++) limiter.fail("u:admin");
    expect(limiter.blocked("u:admin")).toBe(true);
    for (let i = 0; i < 4096; i++) limiter.fail(`ip:10.0.${Math.floor(i / 256)}.${i % 256}`);
    // 缺陷形态（hits.clear()）这里会是 false —— 锁定被攻击者一键归零。
    expect(limiter.blocked("u:admin")).toBe(true);
  });

  it("多轮淘汰后限流器仍然工作（淘汰是有界的，不是把表清空）", () => {
    const limiter = createFailureLimiter({ now: () => 1_000_000, windowMs: 60_000, maxFailures: 5 });
    // 8192 个 key ⇒ 至少触发两轮 MAX_KEYS(4096) 淘汰。
    for (let i = 0; i < 8192; i++) limiter.fail(`ip:172.16.${Math.floor(i / 256)}.${i % 256}`);
    // 淘汰之后新键仍能被正常计数并锁定（若退化成 clear() 或表被写坏，这里会红）。
    for (let i = 0; i < 5; i++) limiter.fail("u:fresh");
    expect(limiter.blocked("u:fresh")).toBe(true);
    // 未达阈值的键不会被误报为已锁定。
    limiter.fail("u:one");
    expect(limiter.blocked("u:one")).toBe(false);
  });
});

// ---------------------------------------------------------------- W9206-15

describe("W9206-15: loadAuthSecret 读路径收紧权限并限制长度", () => {
  it("既有 0644 的密钥文件被读回时收紧为 0600", () => {
    const path = join(tmp(), "studio-auth.secret");
    const secret = loadAuthSecret(path);
    // 先制造「备份恢复 / 宽松 umask」的形态：同一份密钥，权限被放宽。
    writeFileSync(path, `${secret.toString("base64url")}\n`);
    if (FILE_MODES_MEANINGFUL) {
      chmodSync(path, 0o644);
      expect(statSync(path).mode & 0o777).toBe(0o644);
    }
    const again = loadAuthSecret(path);
    expect(again.equals(secret)).toBe(true);
    if (FILE_MODES_MEANINGFUL) expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("超长密钥被重建（长度必须恰好 AUTH_SECRET_BYTES）", () => {
    const path = join(tmp(), "studio-auth.secret");
    const tooLong = Buffer.alloc(AUTH_SECRET_BYTES * 2, 7);
    writeFileSync(path, `${tooLong.toString("base64url")}\n`);
    const secret = loadAuthSecret(path);
    expect(secret).toHaveLength(AUTH_SECRET_BYTES);
    expect(secret.equals(tooLong)).toBe(false);
    expect(Buffer.from(readFileSync(path, "utf8").trim(), "base64url")).toEqual(secret);
  });

  /**
   * 源码守卫（与 w9206-security-fixes.test.ts 里「the terminal spawn wires a
   * stdin error listener and re-checks writability」同一手法）。
   *
   * 为什么需要它：Windows 上 `chmod` 基本无效（`FILE_MODES_MEANINGFUL` 为
   * false），所以「读路径收紧 0600」这条修复在本机无法用 statSync 观测 ——
   * 上一条用例会在缺陷形态下**照样通过**。把「读路径确实调用了收紧」写成对
   * 源码的断言，就在所有平台都有牙（实测：删掉 tightenSecretMode(path) ⇒ 本
   * 用例红）。
   */
  it("读路径确实调用了 tightenSecretMode（跨平台有牙的源码守卫）", async () => {
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("../auth/token.ts", import.meta.url)), "utf8");
    // (a) 命中长度检查的分支里必须调用收紧函数。
    expect(source).toMatch(/decoded\.length === AUTH_SECRET_BYTES\) \{\s*tightenSecretMode\(path\);/);
    // (b) 收紧函数确实 chmod 0600。
    expect(source).toMatch(/function tightenSecretMode\(path: string\): void \{[\s\S]*?chmodSync\(path, 0o600\)/);
  });
});

// ---------------------------------------------------------------- W9206-08

describe("W9206-08: context_window / max_output_tokens 下界", () => {
  it("负数与 0 的 context_window 被拒（400），max_output_tokens 允许 0 但拒负数", async () => {
    const h = make();
    for (const value of [-5, 0]) {
      const res = await getJson(h.app, "/api/config", jsonRequest("POST", { context_window: value }));
      expect(res.status, `context_window=${value}`).toBe(400);
    }
    const neg = await getJson(h.app, "/api/config", jsonRequest("POST", { max_output_tokens: -1 }));
    expect(neg.status).toBe(400);
    // 0 = unset，仍被接受（保持既有语义）。
    const zero = await getJson(h.app, "/api/config", jsonRequest("POST", { max_output_tokens: 0 }));
    expect(zero.status).toBe(200);
    expect(zero.body["max_output_tokens"]).toBeNull();
  });

  it("合法值仍然生效（正向对照）", async () => {
    const h = make();
    const ok = await getJson(h.app, "/api/config", jsonRequest("POST", { context_window: 65536 }));
    expect(ok.status).toBe(200);
    expect(ok.body["context_window"]).toBe(65536);
  });
});

// ---------------------------------------------------------------- W9206-22

describe("W9206-22: 0 字节 registry 不再被读成空表", () => {
  it("空的 workspaces.json 是硬错误，不是空注册表", async () => {
    const root = tmp();
    const file = join(root, "workspaces.json");
    writeFileSync(file, "");
    const { WorkspacesStore } = await import("../store/workspaces.js");
    expect(() => new WorkspacesStore(file)).toThrow(/empty|malformed/i);
  });

  it("空的 providers.json 同样拒绝（该文件存明文密钥）", async () => {
    const root = tmp();
    const file = join(root, "providers.json");
    writeFileSync(file, "");
    const { ProvidersStore } = await import("../store/providers.js");
    expect(() => new ProvidersStore(file)).toThrow(/empty|malformed/i);
  });

  it("缺文件仍然是「无注册表」（不受影响）", async () => {
    const { WorkspacesStore } = await import("../store/workspaces.js");
    const store = new WorkspacesStore(join(tmp(), "workspaces.json"));
    expect(store.registry().workspaces).toEqual([]);
  });
});

// ---------------------------------------------------------------- W9206-23

describe("W9206-23: session.json 原子写", () => {
  it("写入后不留 .tmp 残留，且内容可解析", () => {
    const dir = tmp();
    writeSessionMeta(dir, { title: "我的 会话", mode: "execution" });
    const path = join(dir, "session.json");
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ title: "我的 会话", mode: "execution" });
    expect(readSessionMeta(dir)).toEqual({ title: "我的 会话", mode: "execution" });
  });

  it("是 tmp+rename（换 inode），不是就地覆盖", () => {
    const dir = tmp();
    writeSessionMeta(dir, { title: "old" });
    const path = join(dir, "session.json");
    const witness = join(dir, "witness.json");
    let linked = true;
    try {
      linkSync(path, witness);
    } catch {
      // 某些文件系统（或权限受限的 CI 沙箱）不支持硬链接：显式跳过，不静默当通过。
      linked = false;
    }
    expect(linked, "本用例需要硬链接支持才能判定 inode 是否被替换").toBe(true);
    writeSessionMeta(dir, { title: "new" });
    // 原子写换掉 inode ⇒ 旧硬链接仍是旧内容；就地 writeFileSync 会连同旧链接一起变。
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ title: "new" });
    expect(JSON.parse(readFileSync(witness, "utf8"))).toEqual({ title: "old" });
  });
});

// ---------------------------------------------------------------- W9206-21

describe("W9206-21: disabled 列表有条数上限", () => {
  it("normalizeDisabledTools 截断到 MAX_SESSION_DISABLED_TOOLS", () => {
    const many = Array.from({ length: MAX_SESSION_DISABLED_TOOLS * 3 }, (_, i) => `tool${i}`);
    expect(normalizeDisabledTools(many)).toHaveLength(MAX_SESSION_DISABLED_TOOLS);
  });

  it("PUT 超过上限的列表是 422，而不是被持久化", async () => {
    const h = make({ session: { name: "s1", log: "" } });
    const many = Array.from({ length: MAX_SESSION_DISABLED_TOOLS + 1 }, (_, i) => `tool${i}`);
    const res = await getJson(h.app, "/api/sessions/sample-ws%2Fs1/tools", jsonRequest("PUT", { disabled: many }));
    expect(res.status).toBe(422);
    // 上限内的列表照旧 200。
    const ok = await getJson(
      h.app,
      "/api/sessions/sample-ws%2Fs1/tools",
      jsonRequest("PUT", { disabled: many.slice(0, MAX_SESSION_DISABLED_TOOLS) }),
    );
    expect(ok.status).toBe(200);
  });
});

// ---------------------------------------------------------------- W9206-43

describe("W9206-43: timeout_ms 走 numField（Infinity 是 422）", () => {
  it("1e999 解析成 Infinity 时返回 422 而非落到沙箱 400", async () => {
    const h = make({ session: { name: "s1", log: "" } });
    const res = await getJson(h.app, "/api/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 手写 JSON：JSON.parse("1e999") === Infinity，且 JSON.stringify 会把它变成 null。
      body: '{"command":"echo hi","timeout_ms":1e999}',
    });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------- W9206-44

describe("W9206-44: 非字符串 api_key 是 422，不是静默保留旧密钥", () => {
  it("api_key 为数字/对象时拒绝", async () => {
    const h = make({ session: { name: "s1", log: "" } });
    for (const value of [123, { nested: true }, [1, 2]]) {
      const res = await getJson(h.app, "/api/providers", jsonRequest("POST", { id: "p1", base_url: "http://127.0.0.1:1/v1", api_key: value }));
      expect(res.status, JSON.stringify(value)).toBe(422);
    }
  });

  it("缺省/字符串 api_key 仍按原语义处理（正向对照）", async () => {
    const h = make({ session: { name: "s1", log: "" } });
    const res = await getJson(h.app, "/api/providers", jsonRequest("POST", { id: "p1", base_url: "http://127.0.0.1:1/v1", api_key: "sk-abc" }));
    expect(res.status).toBe(200);
    expect(res.body["has_key"]).toBe(true);
  });
});

// ---------------------------------------------------------------- W9206-45

describe("W9206-45: /api/status 的 isBusy 用规范化 id", () => {
  it("非规范化 session 查询仍命中同一个忙碌实例（空格 -> 下划线）", async () => {
    const seen: string[] = [];
    const base = createFakeRuntimeAdapter({ profile: { model: "m" } });
    const runtime = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "isBusy") {
          return (session?: string | null): boolean => {
            if (session !== undefined) seen.push(String(session));
            return session === "sample-ws/s1_x";
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as RuntimeAdapter;
    const h = make({ session: { name: "s1", log: "" }, runtime });
    // 原始查询值是 "sample-ws/s1 x"（空格），规范 id 是 "sample-ws/s1_x"
    // （sanitizeComponent 把空白折成下划线）。Hono 会解码 %2F，所以只有
    // 「空白」这一支能区分「原始值」与「规范值」——这正是 W815-5 那一类。
    const res = await getJson(h.app, "/api/status?session=sample-ws%2Fs1%20x");
    expect(res.status).toBe(200);
    expect(res.body["session"]).toBe("sample-ws/s1_x");
    // 缺陷形态：isBusy 收到原始 "sample-ws/s1 x"，与规范 id 不匹配，busy 恒 false。
    expect(seen).toContain("sample-ws/s1_x");
    expect(res.body["busy"]).toBe(true);
  });
});

// ---------------------------------------------------------------- W9206-39

describe("W9206-39: /api/fs/list 先排序截断，再对幸存者 lstat", () => {
  it("超过上限的目录只返回 MAX_DIR_ENTRIES 条且 truncated=true（顺序不变）", async () => {
    const { listDirectory } = await import("../handlers/fs.js");
    const { MAX_DIR_ENTRIES } = await import("../config.js");
    const dir = tmp();
    // 目录优先、再按名字：造 3 个子目录 + 远超上限的文件。
    const { mkdirSync } = await import("node:fs");
    for (const name of ["b-dir", "a-dir", "c-dir"]) mkdirSync(join(dir, name));
    for (let i = 0; i < MAX_DIR_ENTRIES + 20; i++) writeFileSync(join(dir, `f${String(i).padStart(4, "0")}.txt`), "x");
    const out = listDirectory(dir);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.truncated).toBe(true);
    expect(out.entries).toHaveLength(MAX_DIR_ENTRIES);
    // 三个目录排在最前（dir 优先），且目录内部按名字升序。
    expect(out.entries.slice(0, 3).map((e) => e.name)).toEqual(["a-dir", "b-dir", "c-dir"]);
    expect(out.entries.slice(0, 3).every((e) => e.type === "dir")).toBe(true);
    // 幸存者仍有完整的 stat 信息（size 对文件是数字、对目录是 null）。
    expect(out.entries[3]?.size).toBe(1);
  });

  it("隐藏项不参与计数（截断发生在其后）", async () => {
    const { listDirectory } = await import("../handlers/fs.js");
    const { MAX_DIR_ENTRIES } = await import("../config.js");
    const dir = tmp();
    for (let i = 0; i < MAX_DIR_ENTRIES + 5; i++) writeFileSync(join(dir, `.hidden${i}`), "x");
    writeFileSync(join(dir, "visible.txt"), "x");
    const out = listDirectory(dir);
    if ("error" in out) throw new Error(out.error);
    expect(out.entries.map((e) => e.name)).toEqual(["visible.txt"]);
    expect(out.truncated).toBe(false);
  });

  /**
   * 源码守卫：这一条缺陷**不改变输出**（旧的「先 lstat 全部再截断」与新的
   * 「先截断再 lstat 幸存者」返回逐字节相同的列表），所以断言输出永远抓不到
   * 它 —— 它省的是**工作量**（十万级目录的主线程同步 lstat 数）。
   * 因此把「截断发生在 describeEntry 之前」写成对源码的断言（与
   * w9206-security-fixes.test.ts 里那条终端源码守卫同一手法）：变异成旧顺序 ⇒
   * 本用例红。
   */
  it("截断发生在 describeEntry（lstat）之前 —— 跨平台有牙的源码守卫", async () => {
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("../handlers/fs.ts", import.meta.url)), "utf8");
    const body = /export function listDirectory\(path: string\)[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
    expect(body).not.toBe("");
    // 唯一一次 describeEntry 调用必须发生在 slice 之后（即只对幸存者 lstat）。
    const describeAt = body.indexOf("describeEntry(");
    const sliceAt = body.indexOf(".slice(0, MAX_DIR_ENTRIES)");
    expect(describeAt).toBeGreaterThan(-1);
    expect(sliceAt).toBeGreaterThan(-1);
    expect(describeAt, "describeEntry 必须在 slice 之后（先截断再 lstat）").toBeGreaterThan(sliceAt);
    // 排序用的是原始 dirent（不需要 stat），不是描述后的条目。
    expect(body).toMatch(/visible\.sort\(\(a, b\) => compareDirents\(a, b\)\)/);
  });
});

// ---------------------------------------------------------------- W9206-41

describe("W9206-41: worker 端点对引擎抛出返回契约 JSON，而不是 text/plain 500", () => {
  it("workerSpawn 抛出时返回 {ok:false,error} 的 502", async () => {
    const base = createFakeRuntimeAdapter({ profile: { model: "m" } });
    const runtime = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "workerSpawn") return async (): Promise<never> => { throw new Error("fleet RPC exploded"); };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as RuntimeAdapter;
    const h = make({ session: { name: "s1", log: "" }, runtime });
    const res = await h.app.request("/api/worker/spawn", jsonRequest("POST", { wid: "W1", brief: "x" }));
    expect(res.status).toBe(502);
    // 契约形状：JSON 且带 ok:false + error（缺陷形态是 text/plain "Internal Server Error"）。
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(false);
    expect(String(body["error"])).toContain("worker spawn failed");
  });
});

// ---------------------------------------------------------------- W9206-13 / W9206-38

describe("W9206-13/38: 请求体有大小上限", () => {
  it("超过上限的 JSON body 是 413，且发生在解析之前", async () => {
    const h = make({ session: { name: "s1", log: "" } });
    const { DEFAULT_JSON_BODY_BYTES } = await import("./common.js");
    // 一个「合法 JSON 但超大」的 body：未加上限时会被完整读进内存并 200。
    const huge = JSON.stringify({ model: "m", system_prompt: "x".repeat(DEFAULT_JSON_BODY_BYTES + 1024) });
    const res = await getJson(h.app, "/api/config", { method: "POST", headers: { "content-type": "application/json" }, body: huge });
    expect(res.status).toBe(413);
    expect(String(res.body["error"])).toContain("limit");
  });

  it("上限内的 body 照旧工作（正向对照）", async () => {
    const h = make({ session: { name: "s1", log: "" } });
    const res = await getJson(h.app, "/api/config", jsonRequest("POST", { model: "m" }));
    expect(res.status).toBe(200);
  });

  it("/api/turn 的预算覆盖 20×4MiB 附件（上限由常量派生，不是手写数）", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./dialog.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/MAX_TURN_ATTACHMENTS \* ATTACHMENT_MAX_BYTES \* 2 \+ DEFAULT_JSON_BODY_BYTES/);
  });
});

// ---------------------------------------------------------------- W9206-47

describe("W9206-47: 终端 409 文案与冻结契约一致", () => {
  it("源码里的 409 字符串等于 contracts/endpoints.json 的冻结文案", async () => {
    const contract = JSON.parse(readFileSync(join(process.cwd(), "contracts", "endpoints.json"), "utf8")) as {
      endpoints: Array<{ id: string; errors: Array<{ status: number; error: string }> }>;
    };
    const frozen = contract.endpoints.find((e) => e.id === "post_terminal_input")?.errors.find((e) => e.status === 409)?.error;
    expect(frozen).toBe("the terminal's input stream is already closed (code=terminal_gone)");
    const source = readFileSync(join(process.cwd(), "apps", "studio", "src", "handlers", "terminal.ts"), "utf8");
    expect(source).toContain(`"the terminal's input stream is already closed"`);
    expect(source).not.toContain(`"this terminal's input stream is closed"`);
  });
});
