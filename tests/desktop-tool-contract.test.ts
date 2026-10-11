// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadTools } from "@celestea/core";

/**
 * computer-use M1 · 四个只读桌面工具的**契约形状**门禁（第二道防线）。
 *
 * 为什么契约「已经唯一真源」还要断言它：`desktopToolSpec()`
 * （packages/computer-use/src/tool.ts）是 `loadTools().tools.find(...)` **直读契约**，
 * 那份设计消灭的是【实现与契约漂移】——但保证不了【契约本身对】。契约写错时，
 * GET /api/tools 会一致地输出同一个错，而且没有任何第二份手写 schema 会顶撞它。
 * 一道「实现不漂移」的防线不能替代一道「契约正确」的防线，这是第二道。
 *
 * 钉的是**结构**不是措辞：description 的文风可改，钉死会让每次润色都要改测试。
 * 真正不可改的是：required 的集合与顺序、封闭性、window 对象的必填对、
 * 布尔开关的默认由实现决定（helper 侧 include_screenshot 默认 true /
 * include_text 默认 false，所以契约只声明类型、不写死默认值——默认值属于实现语义，
 * 在这里钉它会造出第二份真源）。
 *
 * 独立成文件的理由：照 tests/swarm-tool-contract.test.ts 的先例，一条门禁不该
 * 逼着别的文件超行数上限。
 */
describe("contracts/tools.json · desktop read-only four (M1)", () => {
  const t = loadTools();
  const find = (name: string) => t.tools.find((tool) => tool.name === name);

  it("declares exactly the thirteen window2 tools (M1 read-only 4 + M2 write 9)", () => {
    const M1 = ["desktop_list_windows", "desktop_get_window", "desktop_list_apps", "desktop_get_window_state"];
    const M2 = [
      "desktop_click",
      "desktop_press_key",
      "desktop_type_text",
      "desktop_scroll",
      "desktop_set_value",
      "desktop_drag",
      "desktop_secondary_action",
      "desktop_activate_window",
      "desktop_launch_app",
    ];
    for (const name of [...M1, ...M2]) {
      expect(find(name), `contracts/tools.json must declare ${name}`).toBeDefined();
    }
    // 恰好十三个：多一个就是「挂了但必然被闸门拒」的名字（helper 只认 window2 核心面），
    // 少一个就是契约与实现漂移。两个方向都红。
    const declared = t.tools.map((tool) => tool.name).filter((name) => name.startsWith("desktop_"));
    expect(declared.sort()).toEqual([...M1, ...M2].sort());
    // 契约总数同步（M1 加 4：23 -> 27；M2 再加 9：27 -> 36）。
    expect(t.count).toBe(36);
    expect(t.tools).toHaveLength(36);
  });

  it("freezes the two zero-argument discovery tools (closed, no required keys)", () => {
    for (const name of ["desktop_list_windows", "desktop_list_apps"]) {
      const parameters = find(name)?.parameters as { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
      // 封闭对象：未声明参数必须是 schema 错误，不是静默忽略。
      expect(parameters.additionalProperties, name).toBe(false);
      expect(parameters.required, name).toBeUndefined();
      expect(Object.keys(parameters.properties ?? {}), name).toEqual([]);
    }
  });

  it("freezes desktop_get_window: id required, app optional, closed object", () => {
    const parameters = find("desktop_get_window")?.parameters as {
      properties?: Record<string, { type?: string }>;
      required?: string[];
      additionalProperties?: boolean;
    };
    // `toEqual`, NOT `toContain`: required 既是集合也是模型读到的顺序。
    // id 必填、app 可选——helper 侧 get_window 只要 id（helper/src/tools.rs）。
    expect(parameters.required).toEqual(["id"]);
    expect(parameters.additionalProperties).toBe(false);
    expect(Object.keys(parameters.properties ?? {}).sort()).toEqual(["app", "id"]);
    // id 是整数：helper 的 hwnd 句柄在 wire 上是数字（enum_windows 的 to_json），
    // 契约写成 string 会让模型传错类型，helper 侧 require/id 解析直接拒。
    expect(parameters.properties?.["id"]?.type).toBe("integer");
    expect(parameters.properties?.["app"]?.type).toBe("string");
  });

  it("freezes desktop_get_window_state: window required, two optional booleans, nested window closed", () => {
    const parameters = find("desktop_get_window_state")?.parameters as {
      properties?: Record<string, { type?: string; required?: string[]; properties?: Record<string, unknown>; additionalProperties?: boolean }>;
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(parameters.required).toEqual(["window"]);
    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.properties?.["include_screenshot"]?.type).toBe("boolean");
    expect(parameters.properties?.["include_text"]?.type).toBe("boolean");
    // 嵌套 window 同样封闭，且必填 {app,id} —— 缺 app 时 helper 侧无法解析目标窗口。
    const window = parameters.properties?.["window"];
    expect(window?.type).toBe("object");
    expect(window?.additionalProperties).toBe(false);
    expect(window?.required).toEqual(["app", "id"]);
    expect(Object.keys(window?.properties ?? {}).sort()).toEqual(["app", "id", "title"]);
  });

  it("keeps every desktop parameter description non-empty (a blank one tells the model nothing)", () => {
    for (const name of t.tools.map((tool) => tool.name).filter((n) => n.startsWith("desktop_"))) {
      expect(find(name)?.description.trim().length, name).toBeGreaterThan(0);
      const properties = (find(name)?.parameters as { properties?: Record<string, { description?: string }> }).properties ?? {};
      for (const [key, schema] of Object.entries(properties)) {
        expect(schema.description?.trim().length, `${name}.${key}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("contracts/tools.json · desktop write nine (M2)", () => {
  const t = loadTools();
  const find = (name: string) => t.tools.find((tool) => tool.name === name);
  const params = (name: string) =>
    find(name)?.parameters as unknown as {
      // M2-B（一行类型修补，M2-A 的 fcbd5fe 引入的类型漏洞）：嵌套 window 对象自己也有
      // properties，而这个内联类型漏了它 —— 运行时 10/10 全绿，只有 tsc 会红。
      properties?: Record<string, { type?: string; enum?: readonly string[]; required?: string[]; additionalProperties?: boolean; properties?: Record<string, unknown> }>;
      required?: string[];
      additionalProperties?: boolean;
    };

  /**
   * 写工具的 required 集合与顺序，逐一钉死（helper/src/tools.rs 的 window2 写工具表）。
   *
   * 写工具的 required 差异是有意义的、不是笔误：click 只要 window（x/y 与 element_index
   * 互斥，两者皆空是合法调用），而 scroll 要 x+y+两个 delta，drag 要四个坐标。所以这里
   * 逐个列出来，而不是断言一个共同形状——断言共同形状会把这些真实差异全放过去。
   */
  it("freezes the required set of every write tool", () => {
    const expected: Array<[string, string[]]> = [
      ["desktop_click", ["window"]],
      ["desktop_press_key", ["window", "key"]],
      ["desktop_type_text", ["window", "text"]],
      ["desktop_scroll", ["window", "x", "y", "scrollX", "scrollY"]],
      ["desktop_set_value", ["window", "element_index", "value"]],
      ["desktop_drag", ["window", "from_x", "from_y", "to_x", "to_y"]],
      ["desktop_secondary_action", ["window", "element_index", "action"]],
      ["desktop_activate_window", ["window"]],
      ["desktop_launch_app", ["app"]],
    ];
    for (const [name, required] of expected) {
      expect(params(name).required, name).toEqual(required);
    }
  });

  it("keeps every write tool a closed object (an undeclared argument is a schema error)", () => {
    for (const name of [
      "desktop_click", "desktop_press_key", "desktop_type_text", "desktop_scroll",
      "desktop_set_value", "desktop_drag", "desktop_secondary_action",
      "desktop_activate_window", "desktop_launch_app",
    ]) {
      expect(params(name).additionalProperties, name).toBe(false);
    }
  });

  it("pins mouse_button to the helper's six accepted spellings", () => {
    // helper/src/tools.rs 的 click.mouse_button 枚举就是这六个：全名 + 单字母别名。
    // 多一个或少一个都会让模型发出一个 helper 拒绝的字面量。
    expect(params("desktop_click").properties?.["mouse_button"]?.enum).toEqual([
      "left", "right", "middle", "l", "r", "m",
    ]);
  });

  it("keeps the nested window object identical to the read-only tools (one shape, not two)", () => {
    // 八个带 window 的写工具与只读侧共用同一份 {app,id,title} 形状。分成两份 schema 的
    // 那天就会漂移（helper 只会解析一种），所以这里逐个比一次。
    const reference = params("desktop_get_window_state").properties?.["window"];
    for (const name of [
      "desktop_click", "desktop_press_key", "desktop_type_text", "desktop_scroll",
      "desktop_set_value", "desktop_drag", "desktop_secondary_action",
      "desktop_activate_window",
    ]) {
      const window = params(name).properties?.["window"];
      expect(window?.type, name).toBe(reference?.type);
      expect(window?.required, name).toEqual(["app", "id"]);
      expect(window?.additionalProperties, name).toBe(false);
      expect(Object.keys(window?.properties ?? {}).sort(), name).toEqual(["app", "id", "title"]);
    }
  });

  it("keeps scroll's two deltas and drag's four coordinates numeric, and indexes integral", () => {
    expect(params("desktop_scroll").properties?.["scrollX"]?.type).toBe("number");
    expect(params("desktop_scroll").properties?.["scrollY"]?.type).toBe("number");
    for (const key of ["from_x", "from_y", "to_x", "to_y"]) {
      expect(params("desktop_drag").properties?.[key]?.type, key).toBe("number");
    }
    // element_index 是 UIA 节点序号：整数。写成 number 会让模型发小数，helper 侧解析失败。
    for (const name of ["desktop_set_value", "desktop_secondary_action", "desktop_click"]) {
      expect(params(name).properties?.["element_index"]?.type, name).toBe("integer");
    }
    expect(params("desktop_click").properties?.["click_count"]?.type).toBe("integer");
  });
});
