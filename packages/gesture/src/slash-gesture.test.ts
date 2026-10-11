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
    for (const line of ["/help", "/skill:review x", "/mcp:memory a b", "/mcp:memory/search_nodes 找一下"]) {
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
});

describe("parseSlashGesture · 第二层 /mcp:<server>/<tool>（D1）", () => {
  /**
   * 这一组守的是**同一条不变量**换了个形状：server 名里永远不许出现斜杠。
   * 斜杠一旦被切成第二层，被它挡住的就变成 **server 段与工具段各自**的字符集，
   * 而不是整串 —— 所以「server 名不许有斜杠」现在由 MCP_SERVER_NAME_PATTERN
   * 单独挡（下面的变异负控制就钉这一条）。
   */
  it("切出 server 与 tool 两段，raw/canonical 仍是用户原样写的那一截", () => {
    expect(parseSlashGesture("/mcp:memory/search_nodes 找一下")).toEqual({
      kind: "mcp",
      raw: "/mcp:memory/search_nodes",
      canonical: "/mcp:memory/search_nodes",
      name: "memory",
      tool: "search_nodes",
      rest: "找一下",
      end: 24,
    });
  });

  it("没有第二层时 tool 字段整个不存在（调用方用 === undefined 判，别读 falsy）", () => {
    const one = parseSlashGesture("/mcp:memory")!;
    expect(one.tool).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(one, "tool")).toBe(false);
  });

  it("工具名保留大小写与下划线（MCP 工具名大小写敏感）", () => {
    const gesture = parseSlashGesture("/mcp:memory/Create_Entities");
    expect(gesture?.name).toBe("memory");
    expect(gesture?.tool).toBe("Create_Entities");
  });

  it("server 段与工具段各过各的字符集：任一段不合法就整条 null", () => {
    for (const line of [
      "/mcp:-lead/search_nodes",
      "/mcp:" + "a".repeat(33) + "/search_nodes",
      "/mcp:memory/",
      "/mcp:memory/a/b",
      "/mcp:memory/" + "t".repeat(65),
    ]) {
      expect(parseSlashGesture(line), line).toBeNull();
    }
  });

  it("第二层只属于 mcp：/skill:<name>/<tool> 不是手势（不另开一个命名空间的一层）", () => {
    expect(parseSlashGesture("/skill:review/extra")).toBeNull();
    expect(parseSlashGesture("/run/extra")).toBeNull();
  });
});

describe("parseSlashGesture · 行首锚点（判的是「行首」，不是「行里有 /」）", () => {
  /**
   * 为什么单列一组：`3/4` / `a/b` 这类既有用例在 `startsWith` 被换成 `includes` 的
   * 变异下**仍然返回 null**（`readToken` 从 index 1 起读，`a/b` 的尾巴 `b` 不是合法命令名），
   * 于是那批用例对「锚点写错」完全失明——B3 实测：16 条全绿。
   *
   * 下面这批的共同形状：**首个 token 不是 `/`，但句中有一模一样的合法命令形态**。
   * 锚点一旦从「行首」松成「行内」，它们会立刻被解析成手势。
   *
   * ⚠️ **哪几条真正承载这个变异（实测 startsWith→includes 逐条探过，别删这几条）**：
   * `"see a/b for details"`、`"ask /run this"`、`"to /mcp:memory"`、`"foo /skill:review"`、
   * `"foo /mcp:memory"` —— 共同点是**去掉首字符后剩下的 token 本身就是个合法名字**
   * （`ee` / `sk` / `o` / `oo`）。其余各条（`"x/help"`、`"x /help"`、`"run/help"`、
   * `"docs/mcp:memory"`、行首空白那三条）在该变异下**仍然绿**——它们守的是别的变异
   * （例如把 readToken 改成从 index 0 起读、或让解析先 trim），不是这条。
   */
  it("首个 token 不是 / 时一律 null，哪怕句中有一模一样的合法命令形态", () => {
    for (const line of [
      "x/help",
      "x /help",
      "run/help",
      "see a/b for details",
      "ask /run this",
      "to /mcp:memory",
      "ask /mcp:memory/nodes",
    ]) {
      expect(parseSlashGesture(line), line).toBeNull();
    }
  });

  it("句中出现规范形态（/skill: /mcp:）也不是手势", () => {
    for (const line of ["foo /skill:review", "foo /mcp:memory", "docs/mcp:memory", "prefix/skill:review", "foo /mcp:memory/nodes"]) {
      expect(parseSlashGesture(line), line).toBeNull();
    }
  });

  it("行首空白之后的 / 同样不是行首（调用方先 trim，end 才等于原行下标）", () => {
    for (const line of [" /help", "\t/help", "\n/help", " /mcp:memory/nodes"]) {
      expect(parseSlashGesture(line), line).toBeNull();
    }
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
    for (const line of ["/foo:bar", "/Skill:review", "/skill:review:2", "/mcp::memory", "/mcp:memory:2"]) {
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

  it("裸 /<name> 永不代表 MCP（D9 字符串契约）：只有 /mcp: 前缀才是 MCP 形态", () => {
    expect(parseSlashGesture("/memory")?.kind).toBe("command");
    expect(parseSlashGesture("/memory")?.name).toBe("memory");
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
