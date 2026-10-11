import { describe, expect, it } from "vitest";

import { canonicalSlash, parseSlashGesture } from "./slash-gesture.js";

describe("parseSlashGesture · 规范形态与 kind", () => {
  it("/mcp:memory 是 mcp 手势，canonical 与写回形状一致", () => {
    expect(parseSlashGesture("/mcp:memory")).toEqual({
      kind: "mcp",
      raw: "/mcp:memory",
      canonical: "/mcp:memory",
      name: "memory",
      rest: "",
      end: 11,
    });
  });

  it("/skill:review x 拆出 name 与剩余文本（参数原样留给用户）", () => {
    expect(parseSlashGesture("/skill:review x")).toEqual({
      kind: "skill",
      raw: "/skill:review",
      canonical: "/skill:review",
      name: "review",
      rest: "x",
      end: 13,
    });
  });

  it("/help 是命令，规范形态保持 /name", () => {
    expect(parseSlashGesture("/help")).toEqual({
      kind: "command",
      raw: "/help",
      canonical: "/help",
      name: "help",
      rest: "",
      end: 5,
    });
  });

  it("end 恒等于 token 长度（chip 区间右端可由 raw 直接算出）", () => {
    for (const line of ["/help", "/skill:review x", "/mcp:memory a b"]) {
      const gesture = parseSlashGesture(line)!;
      expect(gesture.end, line).toBe(gesture.raw.length);
      expect(line.slice(0, gesture.end), line).toBe(gesture.raw);
      expect(line.slice(gesture.end).replace(/^\s+/, ""), line).toBe(gesture.rest);
    }
  });
});

describe("parseSlashGesture · 只认行首", () => {
  it("句中的 / 不触发（分数、路径、a/b 一律 null）", () => {
    for (const line of ["3/4", "a/b", "看这个 /help 怎么用", "路径 src/ui/commands"]) {
      expect(parseSlashGesture(line), line).toBeNull();
    }
  });

  it("只有 / 或 / 后紧跟空白都不是手势（没有名字可解析）", () => {
    for (const line of ["/", "/ ", "/\t"]) {
      expect(parseSlashGesture(line), line).toBeNull();
    }
  });

  it("参数里的 / 留在 rest 里，不被当成第二个手势", () => {
    expect(parseSlashGesture("/run 3/4")).toEqual({
      kind: "command",
      raw: "/run",
      canonical: "/run",
      name: "run",
      rest: "3/4",
      end: 4,
    });
  });

  it("token 内部的 / 不被接受（mcp server 名里不许出现斜杠）", () => {
    expect(parseSlashGesture("/mcp:a/b")).toBeNull();
  });
});

describe("parseSlashGesture · 字符集按 kind 查表", () => {
  it("命令名只收小写字母开头的词（内置四条与将来注册的同一形状）", () => {
    for (const line of ["/Help", "/_help", "/1help", "/help!"]) {
      expect(parseSlashGesture(line), line).toBeNull();
    }
  });

  it("技能名只收小写字母、数字、连字符", () => {
    expect(parseSlashGesture("/skill:code-review")).not.toBeNull();
    for (const line of ["/skill:Review", "/skill:code_review", "/skill:rev.iew"]) {
      expect(parseSlashGesture(line), line).toBeNull();
    }
  });

  it("mcp server 名比技能名更严：首字符不能是连字符，且长度封顶 32", () => {
    expect(parseSlashGesture("/mcp:" + "a".repeat(32))).not.toBeNull();
    for (const line of ["/mcp:" + "a".repeat(33), "/mcp:-lead", "/mcp:Memory", "/mcp:"]) {
      expect(parseSlashGesture(line), line).toBeNull();
    }
  });

  it("未知前缀不误吃（裸 token 的字符集不含冒号）", () => {
    for (const line of ["/foo:bar", "/Skill:review", "/skill:review:2"]) {
      expect(parseSlashGesture(line), line).toBeNull();
    }
  });
});

describe("parseSlashGesture · 裸 token 的 kind 是语法默认值", () => {
  it("/review 与 /help 在语法上不可区分，一律判 command（清单在调用方手里）", () => {
    expect(parseSlashGesture("/review")?.kind).toBe("command");
    expect(parseSlashGesture("/review")?.name).toBe("review");
  });

  it("调用方认出技能后，用 canonicalSlash 取规范形态即可改写草稿", () => {
    const typed = parseSlashGesture("/review")!;
    const canonical = canonicalSlash("skill", typed.name);
    expect(canonical).toBe("/skill:review");
    expect(parseSlashGesture(canonical!)?.kind).toBe("skill");
  });
});

describe("canonicalSlash", () => {
  it("三种 kind 各产出一种规范形态", () => {
    expect(canonicalSlash("command", "run")).toBe("/run");
    expect(canonicalSlash("skill", "review")).toBe("/skill:review");
    expect(canonicalSlash("mcp", "memory")).toBe("/mcp:memory");
  });

  it("名字不合该 kind 的字符集时返回 null（宁可不改写，也不写半截形状）", () => {
    expect(canonicalSlash("skill", "Review")).toBeNull();
    expect(canonicalSlash("mcp", "memory/x")).toBeNull();
    expect(canonicalSlash("command", "Run")).toBeNull();
  });
});
