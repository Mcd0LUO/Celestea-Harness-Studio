/**
 * EX-03 —— verify-contracts.ts 的检查账本（Check 类型 + 累加器）。
 *
 * 纯搬家：类型、字段顺序、push 顺序、status 字面量均与拆分前逐字一致。
 * 拆分前它们是 verify-contracts.ts 顶部的模块级单例，这里只是换个文件住。
 */
export interface Check {
  endpoint: string;
  kind: "response-shape" | "error-branch" | "sse-transport" | "tool-set" | "contract-count";
  status: "pass" | "fail" | "skip" | "degraded";
  detail: string;
  observedStatus?: number;
  safeBecause?: string;
}

export const checks: Check[] = [];

export function fail(endpoint: string, kind: Check["kind"], detail: string, observedStatus?: number): void {
  checks.push({ endpoint, kind, status: "fail", detail, ...(observedStatus === undefined ? {} : { observedStatus }) });
}
export function pass(endpoint: string, kind: Check["kind"], detail: string, observedStatus?: number, safeBecause?: string): void {
  checks.push({ endpoint, kind, status: "pass", detail, ...(observedStatus === undefined ? {} : { observedStatus }), ...(safeBecause === undefined ? {} : { safeBecause }) });
}
export function degraded(endpoint: string, kind: Check["kind"], detail: string, observedStatus?: number): void {
  checks.push({ endpoint, kind, status: "degraded", detail, ...(observedStatus === undefined ? {} : { observedStatus }) });
}
