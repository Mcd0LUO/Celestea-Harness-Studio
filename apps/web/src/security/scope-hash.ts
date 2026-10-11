// ============================================================================
// security/scope-hash.ts — 提权范围的规范序列化 + SHA-256（契约 §6.4）
//
// 这一对函数是**跨进程契约**：前端把它算出来的摘要放进一次性令牌
// （GET /api/sessions/{id}/grants/token?scope_hash=…），服务端拿到提交体后按
// 自己的公式**重算**再比对；两边任何一个字节不同 ⇒ 每次授予都被判 403。
//
// 服务端 source of truth：`apps/studio/src/store/grants.ts` 的
// `canonicalScopeJson` / `canonicalScopeHash`，形如：
//   {"cap":"write_roots","scope":{"roots":["/a","/b"]}}
//   布尔类 cap（network/unsandboxed）为 {"cap":"network","scope":{}}。
//   M2-B2a：desktop 的 scope 键是 **apps**（嵌套对象），形如
//   {"cap":"desktop","scope":{"apps":{"allow":{"exes":["notepad.exe"]},"deny":{"titles":["x"]}}}}；
//   没有应用清单时为 {"cap":"desktop","scope":{}}（与服务端 OPTIONAL_SCOPE_CAPS 同口径）。
//   嵌套对象必须按**同一套规范化**收敛（trim/去重/排序/丢空侧），否则前端算的哈希
//   与服务端 validateScope 之后的形状对不上 —— 那是 692f19c 的同一类事故。
//
// 历史事故（commit 692f19c）：这里曾只序列化 scope 字段（{"roots":[…]}，没有
// cap/scope 包裹），与服务端哈希不同 ⇒ 令牌绑定的是前端哈希、POST 时服务端按
// 自己的公式重算 ⇒ **每次授予都 403**。两侧必须同步改。
//
// 漂移守护（任一端的形状/算法动了都必须机械失败）：
//   冻结向量   /srv/celestea/studio/contracts/scope-hash-vectors.json
//   前端侧     apps/web/tools/check-scope-hash.mjs（已接进 frontend `pnpm check`）
//   服务端侧   /srv/celestea/studio/tests/scope-hash-vectors.test.ts（vitest）
//
// 本文件**零 import、零 DOM**：既要被浏览器 bundle 打包，也要能被 node 直接
// 导入（Node ≥ 22 的 TS 类型剥离）与 TS 仓的 vitest 导入做逐字对拍。
// 因此下面的 ScopeCap / ScopeLists 是 types.ts:GrantCap/GrantScope 的结构镜像
// （结构相同即可互相赋值），而不是 import —— 保持本模块可独立加载。
// ============================================================================

/** 7 项能力位（结构镜像 types.ts:GrantCap / 服务端 store/grants.ts:GrantCap）。 */
export type ScopeCap =
  | 'network'
  | 'read_roots'
  | 'write_roots'
  | 'net_hosts'
  | 'tool_extra'
  | 'unsandboxed'
  | 'desktop';

/** M2-B2a · 一份应用清单（`desktop` 的 scope，`kind:'apps'` 的两侧之一）。 */
export interface ScopeAppList {
  exes?: string[];
  titles?: string[];
}

/** M2-B2a · 应用级 scope：`allow` 为空 = 不限制；deny 永远赢。 */
export interface ScopeApps {
  allow?: ScopeAppList;
  deny?: ScopeAppList;
}

/** 能力范围列表（结构镜像 types.ts:GrantScope；布尔类 cap 用空对象）。 */
export interface ScopeLists {
  roots?: string[];
  hosts?: string[];
  tools?: string[];
  /** M2-B2a: `desktop` 能力位的应用清单。 */
  apps?: ScopeApps;
}

function scopeKeyOf(cap: string): 'roots' | 'hosts' | 'tools' | 'apps' | null {
  if (cap === 'read_roots' || cap === 'write_roots') return 'roots';
  if (cap === 'net_hosts') return 'hosts';
  if (cap === 'tool_extra') return 'tools';
  // M2-B2a：desktop 的 scope 键是 apps。**在 M2-B2a 之前这里返回 null**，于是
  // 「desktop + 应用清单」会被序列化成 {"cap":"desktop","scope":{}} —— 服务端按
  // 自己的公式（validateScope → canonicalScopeJson，apps 原样保留）重算后与前端
  // 不一致 ⇒ 每次授予 403。这正是文件头注记的 692f19c 同一类形状漂移。
  if (cap === 'desktop') return 'apps';
  return null;
}

/**
 * 规范化一个范围列表：去空白项、逐项 trim、去重（保留首次出现序）、按 UTF-16
 * 码元升序排序（与服务端 validateScope 的 trim+去重、canonicalScopeJson 的
 * `.sort()` 等价）。注意：JS 默认 `.sort()` 是字典序，"/p10" < "/p2"。
 */
function normList(v: readonly string[] | undefined): string[] {
  if (!v) return [];
  return Array.from(new Set(v.map((x) => x.trim()).filter((x) => x !== ''))).sort();
}

/**
 * 规范化一份应用清单（M2-B2a）：逐项 trim / 丢空项 / 去重 / 升序排序；
 * **整份清单为空 ⇒ 该侧整个丢掉**（服务端的 validateAppScope 不产出空侧）。
 */
function normAppList(v: ScopeAppList | undefined): ScopeAppList | null {
  const out: ScopeAppList = {};
  const exes = normList(v?.exes);
  const titles = normList(v?.titles);
  if (exes.length > 0) out.exes = exes;
  if (titles.length > 0) out.titles = titles;
  return out.exes === undefined && out.titles === undefined ? null : out;
}

/**
 * 规范化应用级 scope：键序固定 allow → deny（与 `Object.keys(scope).sort()` 对
 * `{allow,deny}` 的结果一致）。
 *
 * 两侧都空 ⇒ 返回 null（**整个 apps 键丢掉**），因为服务端的 validateAppScope 会
 * 把空侧整个丢掉、且不接受「有 apps 但没有条目」的形状。null 还有一个更细的用处：
 * 调用方据此区分「输入里根本没有 apps」（`undefined`）与「有 apps 但空」
 * ——前者必须收敛成 `{}`（服务端白名单会丢掉非本 cap 的键，desktop 的可选 scope
 * 收敛成 `{}`），后者才是 `{"apps":{}}`。
 */
function normApps(v: ScopeApps | undefined): Record<string, ScopeAppList> | null {
  const out: Record<string, ScopeAppList> = {};
  const allow = normAppList(v?.allow);
  const deny = normAppList(v?.deny);
  if (allow) out['allow'] = allow;
  if (deny) out['deny'] = deny;
  return out['allow'] === undefined && out['deny'] === undefined ? null : out;
}

/** 规范序列化（与服务端 store/grants.ts:canonicalScopeJson 逐字一致，§6.4）。 */
export function canonicalScopeJson(cap: string, scope: ScopeLists): string {
  const key = scopeKeyOf(cap);
  const inner: Record<string, unknown> = {};
  if (key === 'roots') inner['roots'] = normList(scope.roots);
  else if (key === 'hosts') inner['hosts'] = normList(scope.hosts);
  else if (key === 'tools') inner['tools'] = normList(scope.tools);
  else if (key === 'apps' && scope.apps !== undefined) {
    const apps = normApps(scope.apps);
    if (apps !== null) inner['apps'] = apps;
  }
  return JSON.stringify({ cap, scope: inner });
}

/** 规范序列化的 SHA-256 十六进制摘要（= 线上 `scope_hash`）。 */
export async function scopeHashOf(cap: string, scope: ScopeLists): Promise<string> {
  const text = canonicalScopeJson(cap, scope);
  const bytes = new TextEncoder().encode(text);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const buf = await subtle.digest('SHA-256', bytes);
      return toHex(new Uint8Array(buf));
    } catch {
      /* 落到下方自带的实现（例如非安全上下文） */
    }
  }
  return sha256Hex(bytes);
}

/**
 * B5-01：切换档位（PUT /api/sessions/{id}/permission）的一次性令牌绑定摘要。
 *
 * 与 [scopeHashOf] 的区别只有一处**形状**：那一个的 `scope` 永远是
 * `{roots|hosts|tools}`（由 [scopeKeyOf] 选出），而档位切换的绑定对象是
 * `{preset:"<档位 id>"}`。所以这里不走 scopeKeyOf——传 "permission" 会得到
 * `null` 从而序列化成 `{}`，那正是 692f19c 那次事故的同一类形状漂移。
 *
 * 服务端 source of truth：`apps/studio/src/handlers/permissions.ts` 的
 * `permissionScopeHash` / `canonicalPermissionJson`，形如：
 *   {"cap":"permission","scope":{"preset":"full-access"}}
 * 两侧必须同步改，否则每次切换档位都会 403。
 */
export async function permissionScopeHash(preset: string): Promise<string> {
  const text = JSON.stringify({ cap: 'permission', scope: { preset } });
  const bytes = new TextEncoder().encode(text);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const buf = await subtle.digest('SHA-256', bytes);
      return toHex(new Uint8Array(buf));
    } catch {
      /* 落到下方自带的实现（例如非安全上下文） */
    }
  }
  return sha256Hex(bytes);
}

function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/**
 * SHA-256 十六进制摘要（自带实现，仅在上面的浏览器能力不可用时使用）。
 * 为什么自带：页面可能经非安全来源访问，此时拿不到浏览器摘要能力，
 * 而范围哈希是令牌绑定的必要输入——缺失就等于无法授予权限。
 */
export function sha256Hex(bytes: Uint8Array): string {
  return toHex(sha256(bytes));
}

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function sha256(bytes: Uint8Array): Uint8Array {
  const len = bytes.length;
  const blocks = Math.ceil((len + 9) / 64);
  const buf = new Uint8Array(blocks * 64);
  buf.set(bytes);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(blocks * 64 - 8, Math.floor(len / 536870912));
  view.setUint32(blocks * 64 - 4, (len * 8) >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(b * 64 + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h0;
    let bb = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + bb) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((x, i) => dv.setUint32(i * 4, x));
  return out;
}
