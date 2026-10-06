// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadTools } from "@celestea/core";

/**
 * computer-use M1 · 四个只读桌面工具的**契约形状**门禁（第二道防线）。
 *
 * 为什么契约「已经唯一真源」还要断言它：`desktopToolSpec()`
 * （packages/desktop/src/tool.ts）是 `loadTools().tools.find(...)` **直读契约**，
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

  it("declares exactly the four M1 read-only tools, and none of the nine M2 write tools", () => {
    const M1 = ["desktop_list_windows", "desktop_get_window", "desktop_list_apps", "desktop_get_window_state"];
    for (const name of M1) {
      expect(find(name), `contracts/tools.json must declare ${name}`).toBeDefined();
    }
    // 写 9 个在 M2 才进契约（要先有分级闸门，规划 §4）。这里钉住「现在没有」，
    // 所以有人提前登记一个写工具时会被这条挡住——那会绕过闸门的工作。
    const declared = t.tools.map((tool) => tool.name).filter((name) => name.startsWith("desktop_"));
    expect(declared.sort()).toEqual([...M1].sort());
    // 契约总数同步（M1 只加 4：23 -> 27；M2 才 27 -> 36）。
    expect(t.count).toBe(27);
    expect(t.tools).toHaveLength(27);
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
