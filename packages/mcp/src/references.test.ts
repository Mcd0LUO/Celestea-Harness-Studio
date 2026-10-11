/**
 * Credential references: loud failures, no value echo (docs/feature/mcp-client.md §7.2).
 */

import { describe, expect, it } from "vitest";

import { hasReference, resolveReferenceMap, resolveReferences } from "./references.js";

const ENV = { TOKEN: "fx-cred-1", EMPTY: "" };

describe("resolveReferences", () => {
  it("leaves a literal value alone", () => {
    expect(resolveReferences("~/.celestea/memory", ENV)).toEqual({ ok: true, value: "~/.celestea/memory" });
    expect(hasReference("~/.celestea/memory")).toBe(false);
  });

  it("interpolates an embedded reference", () => {
    expect(resolveReferences("Bearer $TOKEN", ENV)).toEqual({ ok: true, value: "Bearer fx-cred-1" });
    expect(resolveReferences("${TOKEN}", ENV)).toEqual({ ok: true, value: "fx-cred-1" });
  });

  it("reports the missing NAME, never the value, and never substitutes empty", () => {
    const result = resolveReferences("Bearer $NOPE", ENV);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.missing).toEqual(["NOPE"]);
    expect(JSON.stringify(result)).not.toContain("fx-cred-1");
  });

  it("treats a bare '$' as an unsupported reference form rather than literal text", () => {
    const result = resolveReferences("price is 5$", ENV);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.invalid).toBe(true);
  });

  it("supports $$ as an escaped literal dollar", () => {
    expect(resolveReferences("cost $$5", ENV)).toEqual({ ok: true, value: "cost $5" });
  });

  it("resolves a whole map and reports every missing name", () => {
    const ok = resolveReferenceMap({ A: "$TOKEN", B: "plain" }, ENV);
    expect(ok).toEqual({ ok: true, value: { A: "fx-cred-1", B: "plain" } });
    const missing = resolveReferenceMap({ A: "$TOKEN", B: "$GONE", C: "$ALSOGONE" }, ENV);
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("unreachable");
    expect([...missing.missing].sort()).toEqual(["ALSOGONE", "GONE"]);
  });
});
