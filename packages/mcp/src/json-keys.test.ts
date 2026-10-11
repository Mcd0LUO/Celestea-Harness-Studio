/**
 * Duplicate-key scanning. `JSON.parse` silently keeps the LAST duplicate, which
 * would turn a pasted-twice server block into a silent configuration change
 * (docs/feature/mcp-client.md §4.1).
 */

import { describe, expect, it } from "vitest";

import { findDuplicateKeys } from "./json-keys.js";

describe("findDuplicateKeys", () => {
  it("finds a repeated server name and reports its path", () => {
    const text = '{"servers":{"memory":{"command":"a"},"memory":{"command":"b"}}}';
    expect(findDuplicateKeys(text).map((d) => d.path)).toEqual(["servers.memory"]);
  });

  it("scopes duplicates to ONE object: two array elements may share a key", () => {
    // 'a' holds two DIFFERENT objects; only 'b' repeats a key inside itself.
    const text = '{"a":[{"x":1},{"x":2}],"b":{"c":1,"c":2}}';
    expect(findDuplicateKeys(text).map((d) => d.path)).toEqual(["b.c"]);
    // A genuine duplicate inside an array element is still found, with its path.
    expect(findDuplicateKeys('{"a":[{"x":1,"x":2}]}').map((d) => d.path)).toEqual(["a.0.x"]);
  });

  it("reports nothing for a well-formed document", () => {
    expect(findDuplicateKeys('{"servers":{"a":{"args":["x","y"]},"b":{"env":{"K":"v"}}}}')).toEqual([]);
  });

  it("does not mistake a repeated VALUE for a repeated key", () => {
    expect(findDuplicateKeys('{"a":"x","b":"x","c":["x","x"]}')).toEqual([]);
  });

  it("survives malformed JSON by bailing out (JSON.parse owns that diagnosis)", () => {
    expect(findDuplicateKeys('{"servers":{"a":')).toEqual([]);
  });
});
