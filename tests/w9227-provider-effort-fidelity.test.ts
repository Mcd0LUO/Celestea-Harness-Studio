// @vitest-environment node
/**
 * W9227 · P1-1 聚焦测试：`reasoning_efforts` 的「缺省 vs 显式 []」必须在生产路径上可区分。
 *
 * 缺陷（审计 results/W9202-配置与提供商页.md P1-1）：`parseModel` 把 providers.json 里
 * **缺键**的行归一成 `[]`，`view()` 又写死 `[...m.reasoning_efforts]` ⇒ 前端永远读到 `[]`，
 * 「未配置 ⇒ 乐观默认三片全选」这条分支**不可达**：存量 provider 打开后显示零片
 * （视觉上等于「不支持推理」），而新建行显示三片 —— 同一模型自相矛盾。
 *
 * 修法（后端保真）：`ProviderModel.reasoning_efforts` 变可选；`parseModel` 只在键
 * present 时写它；`view()` 只在 present 时发它。`[]` 仍是「不支持推理」的权威声明。
 *
 * 五条不变量（每条都能被一个变异打红）：
 *   ① store 读盘：缺键 ⇒ 内存行没有该键（不是 `[]`）；
 *   ② public view：缺键 ⇒ 外发对象**不含**该键；显式 `[]` ⇒ 原样发 `[]`；
 *   ③ 往返：缺键 → upsert（POST 不带该键）后仍缺键；
 *   ④ 能力判定：缺键 = 可推理（乐观默认），显式 `[]` = 不可推理 ⇒ effort 400；
 *   ⑤ available.models 的 `reasoning` 标志与 ④ 用同一个判定（不会自相矛盾）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProvidersStore, reasoningCapable } from "../apps/studio/src/store/providers.js";
import { createFakeRuntimeAdapter } from "../apps/studio/src/fake-runtime-adapter.js";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "../apps/studio/src/harness.test-util.js";

const roots: string[] = [];
const harnesses: StudioHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** 一个 providers.json：`legacy` 缺 reasoning_efforts，`explicit` 是显式 []。 */
function providerFile(): Record<string, unknown> {
  return {
    providers: [
      {
        id: "p1",
        name: "P1",
        note: "",
        base_url: "http://127.0.0.1:3001/v1",
        request_format: "chat_completions",
        api_key: null,
        models: [
          // 缺键：老数据 / 手写 / 从未配过（= 乐观默认，前端应显示三片）
          { id: "legacy", name: "legacy", context_window: null, max_output_tokens: null },
          // 显式空数组：操作员声明「该模型不支持推理」
          { id: "explicit", name: "explicit", reasoning_efforts: [], context_window: null, max_output_tokens: null },
          // 显式非空：正常推理模型
          { id: "listed", name: "listed", reasoning_efforts: ["low", "high"], context_window: null, max_output_tokens: null },
        ],
      },
    ],
    default_model: null,
  };
}

function storeAt(file: Record<string, unknown>): ProvidersStore {
  const dir = mkdtempSync(join(tmpdir(), "w9227-providers-"));
  roots.push(dir);
  const path = join(dir, "providers.json");
  writeFileSync(path, JSON.stringify(file, null, 2));
  return new ProvidersStore(path);
}

function harness(): StudioHarness {
  const h = makeHarness({
    runtime: createFakeRuntimeAdapter({ profile: { model: "legacy" } }),
    files: { "providers.json": providerFile() },
  });
  harnesses.push(h);
  return h;
}

type ModelRow = { id: string; reasoning_efforts?: string[] };
const modelsOf = (body: Record<string, unknown>, providerId: string): ModelRow[] => {
  const providers = body["providers"] as Array<{ id: string; models: ModelRow[] }>;
  return providers.find((p) => p.id === providerId)?.models ?? [];
};

describe("W9227 P1-1 ① store 读盘：缺键保留 absent（不再归一成 []）", () => {
  it("缺 reasoning_efforts 的行在内存里**没有**该键；显式 [] 的行有且为 []", () => {
    const s = storeAt(providerFile());
    const models = s.find("p1")?.models ?? [];
    const byId = new Map(models.map((m) => [m.id, m]));
    // 这是本修复的核心断言：旧实现在这里得到 []（于是「乐观默认」不可达）。
    expect(Object.prototype.hasOwnProperty.call(byId.get("legacy"), "reasoning_efforts")).toBe(false);
    expect(byId.get("legacy")?.reasoning_efforts).toBeUndefined();
    // 显式 [] 必须原样保留 —— 它与缺键是**两个不同的状态**。
    expect(byId.get("explicit")?.reasoning_efforts).toEqual([]);
    expect(byId.get("listed")?.reasoning_efforts).toEqual(["low", "high"]);
  });
});

describe("W9227 P1-1 ② public view：只在 present 时发该键", () => {
  it("缺键的外发行不含 reasoning_efforts；显式 [] 原样发 []", () => {
    const s = storeAt(providerFile());
    const models = s.response().providers[0]?.models ?? [];
    const byId = new Map(models.map((m) => [m.id, m as unknown as Record<string, unknown>]));
    expect("reasoning_efforts" in (byId.get("legacy") ?? {})).toBe(false);
    expect(byId.get("explicit")?.["reasoning_efforts"]).toEqual([]);
    expect(byId.get("listed")?.["reasoning_efforts"]).toEqual(["low", "high"]);
  });

  it("外发是克隆，改它不会污染 store（present 的那条）", () => {
    const s = storeAt(providerFile());
    const first = s.response().providers[0]?.models.find((m) => m.id === "listed");
    first?.reasoning_efforts?.push("max");
    const again = s.response().providers[0]?.models.find((m) => m.id === "listed");
    expect(again?.reasoning_efforts).toEqual(["low", "high"]);
  });
});

describe("W9227 P1-1 ③ 往返：缺键 → upsert（POST 不带该键）→ 仍缺键", () => {
  it("保存一次不带 reasoning_efforts 的行，读回还是 absent", () => {
    const s = storeAt(providerFile());
    s.upsert({
      id: "p1",
      base_url: "http://127.0.0.1:3001/v1",
      request_format: "chat_completions",
      models: [{ id: "legacy", name: "legacy" }],
    });
    expect(s.find("p1")?.models[0]?.reasoning_efforts).toBeUndefined();
    expect(s.response().providers[0]?.models[0]?.reasoning_efforts).toBeUndefined();
  });
});

describe("W9227 P1-1 ④ 能力判定：缺键 = 乐观默认（可推理），显式 [] = 不可推理", () => {
  it("reasoningCapable：absent ⇒ true；[] ⇒ false；非空 ⇒ true", () => {
    expect(reasoningCapable({ id: "a", name: "a", context_window: null, max_output_tokens: null })).toBe(true);
    expect(reasoningCapable({ id: "b", name: "b", reasoning_efforts: [], context_window: null, max_output_tokens: null })).toBe(false);
    expect(reasoningCapable({ id: "c", name: "c", reasoning_efforts: ["low"], context_window: null, max_output_tokens: null })).toBe(true);
  });

  it("POST /api/config：给缺键模型配 effort 被接受，给显式 [] 模型配 effort 被 400 拒绝", async () => {
    const h = harness();
    // 缺键 ⇒ 乐观默认 ⇒ 可推理（旧实现会把这里 400 掉，因为读盘归一成 []）
    const ok = await getJson(h.app, "/api/config", jsonRequest("POST", { model: "legacy", reasoning_effort: "max" }));
    expect(ok.status).toBe(200);
    // 显式 [] ⇒ 操作员声明不支持推理 ⇒ 拒绝
    const refused = await getJson(h.app, "/api/config", jsonRequest("POST", { model: "explicit", reasoning_effort: "max" }));
    expect(refused.status).toBe(400);
    expect(String(refused.body["error"])).toContain("is not a reasoning model");
  });
});

describe("W9227 P1-1 ⑤ available.models 的 reasoning 标志与 ④ 同源", () => {
  it("缺键 ⇒ reasoning:true（前端据此显示三片）；显式 [] ⇒ reasoning:false", async () => {
    const h = harness();
    const { body } = await getJson(h.app, "/api/config");
    const models = (body["available"] as { models: Array<Record<string, unknown>> }).models;
    const byId = new Map(models.map((m) => [m["id"], m]));
    expect(byId.get("legacy")?.["reasoning"]).toBe(true);
    expect(byId.get("explicit")?.["reasoning"]).toBe(false);
    expect(byId.get("listed")?.["reasoning"]).toBe(true);
  });

  it("GET /api/providers 的缺键模型不含 reasoning_efforts 键（前端才能走乐观默认分支）", async () => {
    const h = harness();
    const { body } = await getJson(h.app, "/api/providers");
    const models = modelsOf(body as Record<string, unknown>, "p1");
    const legacy = models.find((m) => m.id === "legacy") ?? {};
    expect("reasoning_efforts" in legacy).toBe(false);
    expect(models.find((m) => m.id === "explicit")?.reasoning_efforts).toEqual([]);
  });
});
