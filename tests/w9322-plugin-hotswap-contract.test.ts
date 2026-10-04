/**
 * W9322 — 契约三处一致 + route snapshot（`docs/feature-plugin-hotswap.md` §5/§6.5）。
 *
 * 新增 `PUT /api/plugins` 让端点计数 **70 -> 71**，而仓里对这个数字有三处独立主张：
 *
 *   ① `FROZEN_COUNTS.endpoints`（`packages/core/src/contracts/index.ts`）——冻结锚点；
 *   ② `contracts/endpoints.json` 的 `count` 字段 **与** `endpoints[]` 的长度；
 *   ③ `API_ENDPOINT_COUNT`（`apps/studio/src/routes.ts`，从 ① 派生）与
 *      `contracts/route-table.snapshot.json` 的 `tsApiEndpoints` / `tsMethodPathCombos`。
 *
 * 本文件把三处**同时**钉住，并且把「新端点真的在 TS-only 名单里」也钉住——
 * 快照的 `routes[]` 是退役后端的冻结抽取，一个新端点只能出现在 `tsOnlyRoutes`。
 * 另外钉住契约标题里的数字：它是散文，无法派生，但**可以被校验**（W9213 的教训）。
 */

import { describe, expect, it } from "vitest";
import { API_ENDPOINT_COUNT } from "../apps/studio/src/routes.js";
import { FROZEN_COUNTS, loadEndpoints, loadRouteSnapshot } from "@celestea/core";

const c = loadEndpoints();
const byId = new Map(c.endpoints.map((e) => [e.id, e]));

describe("W9322 PUT /api/plugins (contract delta)", () => {
  it("adds exactly ONE endpoint and keeps the three counts in agreement", () => {
    const put = byId.get("put_plugins");
    expect(put?.path).toBe("/api/plugins");
    expect(put?.method).toBe("PUT");
    expect(put?.request.kind).toBe("json");
    // Both body fields are OPTIONAL: that IS the back-compat rule (§5), so the
    // contract has to say so rather than leaving it to the handler's prose.
    expect(put?.request.fields.map((f) => f.name)).toEqual(["disabled", "enabled"]);
    for (const field of put?.request.fields ?? []) expect(field.required).toBe(false);
    expect(String(put?.request.fields[0]?.note)).toContain("OPTIONAL");
    expect(String(put?.request.fields[1]?.note)).toContain("complement");
    expect(put?.response.fields.map((f) => f.name)).toEqual(["ok", "plugins", "disabled"]);
    // 这里**故意不钉** `docRef` 的字面路径：文档归档时它合法地变过，而"指针指到真文件"这件事
    // 已由 `tests/contract-store.test.ts` 的「契约文档指针可达性」机械守着 ⇒ 两处守同一件事，
    // 其中一处还钉死了字面量（铁律 11：守后果，不守机制）。

    // ① the frozen anchor, ② the file's declared count and its array length,
    // ③ the derived constant the boot assertion reads.
    expect(FROZEN_COUNTS.endpoints).toBe(71);
    expect(c.count).toBe(FROZEN_COUNTS.endpoints);
    expect(c.endpoints).toHaveLength(FROZEN_COUNTS.endpoints);
    expect(API_ENDPOINT_COUNT).toBe(FROZEN_COUNTS.endpoints);
  });

  it("states the endpoint count in the contract title consistently with endpoints[]", () => {
    const stated = /^(.*) \((\d+) endpoints\)$/.exec(c.title);
    expect(stated, "the contract title must state '<...> (N endpoints)'").not.toBeNull();
    expect(Number(stated?.[2])).toBe(FROZEN_COUNTS.endpoints);
  });

  it("declares the new route as TypeScript-only and keeps the snapshot's own counts true", () => {
    const snap = loadRouteSnapshot();
    const frozen = snap.routes.filter((r) => r.path.startsWith("/api/"));
    // The LEGACY extraction is a frozen historical fact: it must never move.
    expect(frozen).toHaveLength(39);
    const tsOnly = snap.tsOnlyRoutes ?? [];
    const keys = tsOnly.map((r) => `${r.method} ${r.path}`);
    expect(keys).toContain("GET /api/plugins");
    expect(keys).toContain("PUT /api/plugins");
    expect(tsOnly).toHaveLength(FROZEN_COUNTS.endpoints - frozen.length);
    expect(snap.tsApiEndpoints).toBe(FROZEN_COUNTS.endpoints);
    expect(snap.tsMethodPathCombos).toBe(FROZEN_COUNTS.endpoints + snap.staticRoutes.length);
    // The snapshot and the contract describe the same set, name for name.
    const fromSnapshot = new Set([...frozen, ...tsOnly].map((r) => `${r.method} ${r.path}`));
    expect(fromSnapshot.size).toBe(FROZEN_COUNTS.endpoints);
    expect([...new Set(c.endpoints.map((e) => `${e.method} ${e.path}`))].sort()).toEqual([...fromSnapshot].sort());
  });

  it("freezes the refusals the handler really returns (409 for a busy host, 422 for a required row)", () => {
    const put = byId.get("put_plugins");
    const errors = put?.errors ?? [];
    const busy = errors.find((e) => e.status === 409);
    const required = errors.find((e) => e.status === 422 && e.error.includes("cannot be disabled"));
    expect(busy, "the idle-only refusal must be in the contract").toBeDefined();
    expect(String(busy?.error)).toContain("active");
    expect(String(busy?.note)).toContain("busy_sessions");
    expect(required, "the required-row refusal must be in the contract").toBeDefined();
    expect(String(required?.error)).toContain("plugin '{name}' cannot be disabled");
    // The turn-boundary semantics and the single-source constraint are contract
    // text, not only handler comments (docs/feature-plugin-hotswap.md §3.1).
    const notes = (put?.notes ?? []).join("\n");
    expect(notes).toContain("turn boundary");
    expect(notes).toContain("swarm/src/plugin.ts");
    expect(notes).toContain("SerialQueue");
  });

  it("re-states GET /api/plugins as a TWO-layer inventory (the W860 boundary is gone)", () => {
    const get = byId.get("get_plugins");
    expect(get?.response.fields.map((f) => f.name)).toEqual(["ok", "plugins", "disabled", "warnings"]);
    const type = String(get?.response.fields.find((f) => f.name === "plugins")?.type);
    expect(type).toContain('"engine"');
    expect(type).toContain("enabled");
    expect(type).toContain("disable");
    const notes = (get?.notes ?? []).join("\n");
    expect(notes).toContain("celestea.runtime.swarm");
    expect(notes).toContain("Runtime.pluginNames");
    // The stale W860 claim ("layer is always host and hot always false") is gone.
    expect(JSON.stringify(get)).not.toContain("hot always false");
  });
});
