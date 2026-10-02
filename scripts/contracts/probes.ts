/**
 * EX-03 —— 探针执行器：把 §1 GET 形状探针与 §2 错误分支探针各自收敛成
 * 「数据表 + runProbe() 循环」，main() 只剩编排。
 *
 * 纯搬家：循环体、判定顺序、fail/pass 的 detail 文案全部逐字保留；
 * 每条探针跑几次、按什么顺序跑（数组字面量序）也与拆分前一致。
 */
import type { EndpointContract } from "@celestea/core";
import { probe } from "../lib/http.js";
import { fail, pass } from "./checks.js";
import { ERROR_PROBES, type ErrorProbe } from "./error-probes.js";
import { BESPOKE_GET, concreteProbePath, contractFieldNames, topKeys } from "./shape.js";
import { STUDIO, TIMEOUT } from "./runtime.js";

/**
 * §1 —— GET 端点的状态码 + 顶层响应形状断言。
 *
 * 一个端点 = 一次探测 + 一条记录：命中 BESPOKE_GET 的走各自的诚实断言
 * （/login 是 HTML、/auth/check 是 cookie 门控），其余走通用顶层键比较。
 */
async function runGetProbe(e: EndpointContract, sampleSessionId: string): Promise<void> {
  const probePath = concreteProbePath(e.path, sampleSessionId);
  const res = await probe(STUDIO, probePath, { timeoutMs: TIMEOUT });
  const bespoke = BESPOKE_GET[e.id];
  if (bespoke) {
    const b = bespoke(res);
    if (b.ok) pass(`${e.method} ${e.path}`, "response-shape", b.detail, res.status);
    else fail(`${e.method} ${e.path}`, "response-shape", b.detail, res.status);
    return;
  }
  if (res.status !== e.response.status) {
    fail(`${e.method} ${e.path}`, "response-shape", `expected HTTP ${e.response.status}, got ${res.status}`, res.status);
    return;
  }
  const observed = topKeys(res.json);
  const declared = contractFieldNames(e);
  const required = contractFieldNames(e, false);
  const missing = required.filter((k) => !observed.includes(k));
  const optionalAbsent = declared.filter((k) => !observed.includes(k));
  const additive = observed.filter((k) => !declared.includes(k));
  if (missing.length > 0) {
    fail(`${e.method} ${e.path}`, "response-shape", `missing contract field(s): ${missing.join(", ")} (observed: ${observed.join(", ")})`, res.status);
  } else {
    pass(
      `${e.method} ${e.path}`,
      "response-shape",
      `HTTP ${res.status}; ${observed.length} key(s)${optionalAbsent.length > 0 ? `; optional absent: ${optionalAbsent.join(", ")}` : ""}${additive.length > 0 ? `; additive (not in contract doc): ${additive.join(", ")}` : ""}`,
      res.status,
    );
  }
}

/** §1 的表格：W516 的四个 grant 端点是 TypeScript-only（checked === false），不参与探测。 */
export async function runGetProbes(probeable: EndpointContract[], sampleSessionId: string): Promise<void> {
  for (const e of probeable.filter((x) => x.method === "GET" && x.id !== "get_events")) {
    await runGetProbe(e, sampleSessionId);
  }
}

/** §2 的一条错误分支探针：状态码先对，再看错误文案是否含约定的那个词。 */
async function runErrorProbe(p: ErrorProbe): Promise<void> {
  const res = await probe(STUDIO, p.path, { method: p.method, body: p.body, timeoutMs: TIMEOUT });
  const text = res.text;
  if (res.status !== p.expectStatus) {
    fail(`${p.method} ${p.path}`, "error-branch", `expected HTTP ${p.expectStatus}, got ${res.status}: ${text.slice(0, 200)}`, res.status);
    return;
  }
  if (p.expectError !== "ok" && !text.includes(p.expectError)) {
    fail(`${p.method} ${p.path}`, "error-branch", `HTTP ${res.status} but the error text lacks '${p.expectError}': ${text.slice(0, 200)}`, res.status);
    return;
  }
  pass(`${p.method} ${p.path}`, "error-branch", `HTTP ${res.status}${p.expectError === "ok" ? "" : ` + "${p.expectError}"`}`, res.status, p.safeBecause);
}

export async function runErrorProbes(): Promise<void> {
  for (const p of ERROR_PROBES) {
    await runErrorProbe(p);
  }
}
