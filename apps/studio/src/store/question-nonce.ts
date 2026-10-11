/**
 * M2 — the answer nonce for `POST /api/questions/{id}/answer`.
 *
 * ## 为什么需要它（一条真实的越权路径）
 *
 * 分级闸门（packages/computer-use/src/gate.ts）把「敏感桌面操作每次都要人点一下」实现成
 * 一张**挂起的 question**，人的裁决经同一个端点回来。于是「模型无权跳过闸门」这句话
 * 完全依赖「模型答不了这张问题」——而它本来答得了：
 *   · question id 是顺序可猜的 `q-<n>`（question-registry.ts::nextRequestId）；
 *   · `GET /api/questions` 会列出全部未决问题（含 id），且它是 GET，不受
 *     crossSiteRefusal 管（handlers/common.ts 只拦写方法）；
 *   · 会话自己的 `http_request` 工具能转发任意 header 与 body；
 *   · 端点原先唯一的守卫是 body 里的 `session` 字段，而模型知道自己的会话 id。
 * 默认部署（回环绑定、未配 api token）下，一个被授予 `network` 且策略允许回环的
 * 会话就能自己 POST 一个答案，把自己批准掉。
 *
 * ## 修法：照 W9206-03 的 HttpOnly nonce
 *
 * 与「授予令牌」同一个形状、同一条理由（store/grants-tokens.ts）：nonce 只经
 * `Set-Cookie` 下发，而 `http_request` 的响应视图是 HEADER_SUBSET——它**不含**
 * `set-cookie`（packages/tools/src/http/headers.ts 写明了为什么），而且它没有
 * cookie jar（每次调用新建请求）⇒ 工具既读不到、也带不上这个值；浏览器对同源请求
 * 则自动保存与回送。
 *
 * ## 为什么是**进程级一个值**，而不是每题一个
 *
 * 下发通道决定形状：能给浏览器种 cookie 的只有它**本来就会发**的 GET
 * （`GET /api/events` 与 `GET /api/questions`），而这两个请求与「哪一道题」无关。
 * 每题一个 nonce 就得先把它交给浏览器、再由浏览器带着它答题——那需要一条新端点，
 * 而 M2 明确零新增端点（规划 §4.2）。安全性不因此降低：它是 32 字节随机值，
 * 模型既读不到也猜不到，而**能读到它的只有浏览器**。
 *
 * 进程重启 ⇒ nonce 重铸 ⇒ 旧 cookie 立刻失效；浏览器下一次连上 SSE 就会拿到新的
 * （`GET /api/events` 每次都下发，见 handlers/dialog.ts）。失效的方向是 fail-closed：
 * 最坏情况是用户看到一次 403 并需要刷新页面，而不是某个答案被静默接受。
 *
 * ## 有效期为什么是「会话 cookie」
 *
 * 授予令牌的 nonce 带 `Max-Age=60`（那个令牌本身就是一次性、60 秒的）。本 nonce
 * 必须活到用户答完任意一张问题为止，所以**不设 Max-Age**：它是会话 cookie，
 * 浏览器关掉即丢，服务端重铸即作废——两个方向都不会留下长期凭据。
 */

import { timingSafeEqual } from "node:crypto";

/** 答案必须回送的 cookie 名（与授予 nonce 分开：两者的生命周期完全不同）。 */
export const QUESTION_NONCE_COOKIE = "celestea_question_nonce";

/** 32 字节随机值，hex 编码（与授予 nonce 同宽）。 */
const NONCE_BYTES = 32;

let current: string | null = null;

/** 本进程的 nonce：首次调用时铸造，之后恒定。 */
export function questionNonce(): string {
  if (current === null) current = randomNonce();
  return current;
}

/**
 * 答案带着的 nonce 对不对。
 *
 * 空/缺失/长度不等一律 false；长度相同时用常数时间比较（照
 * grants-tokens.ts::timingSafeEqualString 的口径——长度本身不是秘密，
 * 比较过程不该泄漏前缀匹配到第几位）。
 */
export function questionNonceMatches(candidate: string | null | undefined): boolean {
  if (typeof candidate !== "string" || candidate === "") return false;
  const expected = Buffer.from(questionNonce(), "utf8");
  const given = Buffer.from(candidate, "utf8");
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/**
 * `Set-Cookie` 的值。属性表照 handlers/grants.ts::grantNonceCookie：HttpOnly
 * （脚本读不到）、SameSite=Strict（跨站页面骑不上）、Path=/（与那个 cookie 同口径），
 * 只有走 TLS 时才加 Secure（回环上的 http 加 Secure 会让浏览器直接丢弃它）。
 */
export function questionNonceCookie(value: string, secure: boolean): string {
  const attrs = [QUESTION_NONCE_COOKIE + "=" + value, "Path=/", "HttpOnly", "SameSite=Strict"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/**
 * `Secure` 该不该加：只有真走 TLS 时才加（同 handlers/grants.ts::isSecureRequest 的规则）。
 *
 * 抽成**纯函数**而不是各 handler 再抄一份，是因为这个判断抄错的后果不对称：
 * 回环上的 http 加上 Secure 会让浏览器**直接丢弃**整个 cookie，于是所有人都答不了题。
 */
export function secureCookieFor(forwardedProto: string | undefined): boolean {
  const first = (forwardedProto ?? "").toLowerCase().split(",")[0];
  return first !== undefined && first.trim() === "https";
}

function randomNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
