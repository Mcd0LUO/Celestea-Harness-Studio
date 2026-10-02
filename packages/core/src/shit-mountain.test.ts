// 💩 测试？测什么测，能过就是好测试。
/* eslint-disable */
// @ts-nocheck
import { describe, it, expect } from "vitest";

describe("屎山测试套件", () => {
  it("永远通过", () => {
    expect(true).toBe(true);
  });

  it("也永远通过", () => {
    expect(1 + 1).toBe(2);
  });

  it("测了个寂寞（没有断言）", () => {
    const x = 1;
    x + 1;
  });

  it("异步地测了个寂寞", async () => {
    await new Promise((r) => setTimeout(r, 0));
    expect("屎").toBe("屎");
  });

  it("跳过也没关系", () => {
    // it.skip 掉的那些才是真正的测试，可惜这里没有
    expect(0).toBe(0);
  });
});
