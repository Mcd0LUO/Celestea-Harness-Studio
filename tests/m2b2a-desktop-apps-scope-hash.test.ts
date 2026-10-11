// ============================================================================
// M2-B2a · desktop（apps scope）的**前后端逐字对拍**。
//
// WHY：apps 是唯一一个**嵌套对象**的 scope（allow/deny × exes/titles）。冻结向量
// contracts/scope-hash-vectors.json 里没有任何 apps 条目（那份文件本轮不动），
// 所以「前端提交的 desktop 形状 == 服务端 validateScope 之后的形状」这件事没有
// 任何机械保护 —— 而它一旦漂移，表现就是**每次授予 403**（历史事故 692f19c 的
// 同一类形状问题；见 apps/web/src/security/scope-hash.ts 头注）。
//
// 做法：沿用 tests/scope-hash-vectors.test.ts 的同一手法 —— 用 URL 形式的动态
// import 把**服务端真实实现**（validateScope / canonicalScopeJson /
// canonicalScopeHash）拉进来，与前端纯函数（canonicalScopeJson / scopeHashOf）
// 对同一份输入逐字比对。测的是真代码，不是这里手抄的一份期望值。
// ============================================================================
import { describe, expect, it } from "vitest";

interface FrontendScopeHash {
  canonicalScopeJson(cap: string, scope: Record<string, unknown>): string;
  scopeHashOf(cap: string, scope: Record<string, unknown>): Promise<string>;
}

interface ServerGrants {
  validateScope(
    cap: string,
    raw: unknown,
    known: readonly string[],
  ): { ok: true; scope: Record<string, unknown> } | { ok: false; error: string };
  canonicalScopeJson(cap: string, scope: Record<string, unknown>): string;
  canonicalScopeHash(cap: string, scope: Record<string, unknown>): string;
}

const frontend = (await import(
  /* @vite-ignore */ new URL("../apps/web/src/security/scope-hash.ts", import.meta.url).href
)) as unknown as FrontendScopeHash;
const server = (await import(
  /* @vite-ignore */ new URL("../apps/studio/src/store/grants.ts", import.meta.url).href
)) as unknown as ServerGrants;

/** 服务端用空集：下面的值都不是凭据形状（与冻结向量那份测试同口径）。 */
const NO_KNOWN_SECRETS: readonly string[] = [];

/** 对拍一个形状：服务端 validateScope → canonicalScopeHash，前端同输入同摘要。 */
async function bothHash(scope: Record<string, unknown>): Promise<{ json: string; hash: string }> {
  const validated = server.validateScope("desktop", scope, NO_KNOWN_SECRETS);
  expect(validated.ok, `服务端拒绝了 desktop 的 apps scope：${JSON.stringify(scope)}`).toBe(true);
  if (!validated.ok) throw new Error("unreachable");
  const json = server.canonicalScopeJson("desktop", validated.scope);
  const hash = server.canonicalScopeHash("desktop", validated.scope);
  // 前端拿到的是**用户提交的原始形状**（未经服务端校验），必须得到同一个摘要。
  expect(frontend.canonicalScopeJson("desktop", scope), `canonical_json 漂移：${JSON.stringify(scope)}`).toBe(json);
  expect(await frontend.scopeHashOf("desktop", scope), `scope_hash 漂移：${JSON.stringify(scope)}`).toBe(hash);
  return { json, hash };
}

describe("M2-B2a desktop/apps：前端形状与服务端 canonicalScopeHash 逐字一致", () => {
  it("allow 只有 exes", async () => {
    const { json } = await bothHash({ apps: { allow: { exes: ["notepad.exe"] } } });
    expect(json).toBe('{"cap":"desktop","scope":{"apps":{"allow":{"exes":["notepad.exe"]}}}}');
  });

  it("deny 只有 titles", async () => {
    const { json } = await bothHash({ apps: { deny: { titles: ["命令提示符"] } } });
    expect(json).toBe('{"cap":"desktop","scope":{"apps":{"deny":{"titles":["命令提示符"]}}}}');
  });

  it("allow 与 deny 同时存在：键序固定 allow → deny", async () => {
    const { json } = await bothHash({
      apps: { deny: { exes: ["cmd.exe"] }, allow: { exes: ["notepad.exe"], titles: ["Untitled - Notepad"] } },
    });
    expect(json).toBe(
      '{"cap":"desktop","scope":{"apps":{"allow":{"exes":["notepad.exe"],"titles":["Untitled - Notepad"]},"deny":{"exes":["cmd.exe"]}}}}',
    );
  });

  it("规范化：去重 + 字典序排序（两侧同一套）", async () => {
    const { json } = await bothHash({
      apps: {
        allow: { exes: ["b.exe", "a.exe", "b.exe"], titles: ["z", "a"] },
        deny: { exes: ["C:\\Program Files\\App\\a.exe"] },
      },
    });
    // exes/titles 都按 JS 默认 sort（UTF-16 码元序，字典序，不是数值序）。
    expect(json).toBe(
      '{"cap":"desktop","scope":{"apps":{"allow":{"exes":["a.exe","b.exe"],"titles":["a","z"]},"deny":{"exes":["C:\\\\Program Files\\\\App\\\\a.exe"]}}}}',
    );
  });

  it("逐项 trim 与去空白项：**服务端会拒未 trim 的值**，所以前端必须先 trim 再提交", () => {
    // 服务端的 looksLikeCredential 把「首尾空白」直接判为凭据形状（W516 §5.4 的口径），
    // 于是 ' b.exe' 这种值会得到 400 —— 前端 splitAppEntries 的逐项 trim 不是美化，
    // 是**提交能不能通过**的前提。
    expect(server.validateScope("desktop", { apps: { allow: { exes: [" b.exe"] } } }, NO_KNOWN_SECRETS).ok).toBe(false);
    const trimmed = { apps: { allow: { exes: ["a.exe", "b.exe"] } } };
    const validated = server.validateScope("desktop", trimmed, NO_KNOWN_SECRETS);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const json = server.canonicalScopeJson("desktop", validated.scope);
    expect(json).toBe('{"cap":"desktop","scope":{"apps":{"allow":{"exes":["a.exe","b.exe"]}}}}');
    // 前端把「未 trim + 重复」的形状收敛成同一个摘要（= 服务端校验后的形状）。
    expect(frontend.canonicalScopeJson("desktop", { apps: { allow: { exes: [" b.exe", "a.exe", "b.exe"] } } })).toBe(json);
  });

  it("带空格的值不会被切开（Windows 路径与窗口标题）", async () => {
    const { json } = await bothHash({
      apps: { allow: { exes: ["C:\\Program Files\\App\\a.exe"], titles: ["另存为 - 记事本"] } },
    });
    expect(json).toContain('"C:\\\\Program Files\\\\App\\\\a.exe"');
    expect(json).toContain('"另存为 - 记事本"');
  });

  it("空的一侧整个丢掉（前端把空侧收敛成「没有这一侧」）", () => {
    // 注意：**服务端会直接拒绝空数组**（见下面「服务端会拒的形状」），所以这条不能走
    // bothHash 的对拍路径 —— 它测的是前端自己的规范化：空侧不产出，结果与服务端对
    // 「只带 allow.exes」这一形状校验后**逐字相同**。
    const withEmptySides = { apps: { allow: { exes: ["a.exe"], titles: [] }, deny: { exes: [] } } };
    const clean = { apps: { allow: { exes: ["a.exe"] } } };
    const json = frontend.canonicalScopeJson("desktop", withEmptySides);
    expect(json).toBe('{"cap":"desktop","scope":{"apps":{"allow":{"exes":["a.exe"]}}}}');
    const validated = server.validateScope("desktop", clean, NO_KNOWN_SECRETS);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(json).toBe(server.canonicalScopeJson("desktop", validated.scope));
  });

  it("没有 apps 键 ⇒ 两侧都收敛成 {}（= 纯能力位，与 M2-B 升级前逐字相同）", async () => {
    const { json, hash } = await bothHash({});
    expect(json).toBe('{"cap":"desktop","scope":{}}');
    // 反空转：上面那条必须是「空 scope」的哈希，而不是某个带 apps 的形状。
    expect(hash).toBe(server.canonicalScopeHash("desktop", {}));
  });

  it("apps 为空对象 ⇒ 前端收敛成 {}（不产出服务端会拒的「有 apps 没条目」形状）", () => {
    // 同样不能走 bothHash：`{apps:{}}` 是服务端明确拒绝的形状（400），而它恰恰是
    // 「四个框都填了又都删空」时最容易构造出来的形状 —— 前端必须把它收敛成 {}。
    const json = frontend.canonicalScopeJson("desktop", { apps: {} });
    expect(json).toBe('{"cap":"desktop","scope":{}}');
    expect(json).toBe(server.canonicalScopeJson("desktop", {}));
  });

  it("非本 cap 的键（roots/hosts/tools）在两侧都被丢掉", async () => {
    const { json } = await bothHash({ roots: ["/ignored"], apps: { allow: { exes: ["a.exe"] } } });
    expect(json).toBe('{"cap":"desktop","scope":{"apps":{"allow":{"exes":["a.exe"]}}}}');
    const only = await bothHash({ roots: ["/ignored"] });
    expect(only.json).toBe('{"cap":"desktop","scope":{}}');
  });

  it("前端摘要与「服务端校验后的形状」一致，且与冻结向量同一算法", async () => {
    const scope = { apps: { allow: { exes: ["a.exe"] } } };
    const validated = server.validateScope("desktop", scope, NO_KNOWN_SECRETS);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    // 同一条规范 JSON 的两个哈希路径（前端 WebCrypto 与 node:crypto）必须相等。
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(server.canonicalScopeJson("desktop", validated.scope), "utf8").digest("hex")).toBe(
      await frontend.scopeHashOf("desktop", scope),
    );
  });
});

describe("M2-B2a desktop/apps：服务端会拒的形状（前端必须在提交前挡住）", () => {
  const rejected: Array<[string, Record<string, unknown>]> = [
    ["空的 allow 数组", { apps: { allow: { exes: [] } } }],
    ["apps 里一个条目都没有", { apps: {} }],
    ["超过 32 项", { apps: { allow: { exes: Array.from({ length: 33 }, (_, i) => `a${i}.exe`) } } }],
    ["单项超过 200 字符", { apps: { allow: { exes: ["x".repeat(201)] } } }],
    ["非字符串项", { apps: { allow: { exes: [1] } } }],
    ["空白项", { apps: { allow: { exes: ["   "] } } }],
    ["apps 不是对象", { apps: ["a.exe"] }],
  ];

  for (const [name, scope] of rejected) {
    it(`服务端拒绝：${name}`, () => {
      expect(server.validateScope("desktop", scope, NO_KNOWN_SECRETS).ok).toBe(false);
    });
  }
});
