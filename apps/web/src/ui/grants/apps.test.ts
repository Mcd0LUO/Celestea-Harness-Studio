// ============================================================================
// M2-B2a · desktop 能力位的应用清单：解析 / 校验 / scope 形状 / 面板行。
//
// WHY：desktop 从 `bool` 升级成 `apps` 之后，「四个文本框里的字」到「提交给服务端的
// scope」之间多了一层**形状翻译**（allow/deny × exes/titles 的嵌套对象）。这层翻译错了
// 不会报错，只会让授予 403（scope_hash 对不上）或让「留空 = 不限制」的语义反转。
// 所以这里钉三件事：
//   ① 形状：四框 → scope（空侧不产出、两侧都空 = 不带 apps 键）；
//   ② 语义：空 allow 说「不限制」，deny 永远赢，摘要给的是条数；
//   ③ 面板行：真的渲染出四个框、授予后真的显示清单摘要。
// ============================================================================
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  appsOfScope,
  appsScopeOf,
  appsSummary,
  desktopScopeOf,
  emptyAppsDraft,
  splitAppEntries,
  validateAppsDraft,
  type AppsDraft,
} from "./apps";
import { setLocale } from "../../i18n";

/** 固定中文，断言的是「固定句式 + 数据填参」而不是具体语言的措辞。 */
setLocale("zh");

function draftOf(patch: Partial<AppsDraft>): AppsDraft {
  return { ...emptyAppsDraft(), ...patch };
}

describe("M2-B2a 应用清单：草稿 → scope 形状", () => {
  it("四个框全空 ⇒ scope 是 {}（= 纯能力位，与升级前的 bool 形状逐字相同）", () => {
    expect(desktopScopeOf(emptyAppsDraft())).toEqual({});
    expect(appsScopeOf(emptyAppsDraft())).toBeNull();
  });

  it("只有 allow 有内容 ⇒ { apps: { allow: … } }，空侧不产出", () => {
    const scope = desktopScopeOf(draftOf({ allowExes: "notepad.exe" }));
    expect(scope).toEqual({ apps: { allow: { exes: ["notepad.exe"] } } });
  });

  it("只有 deny 有内容 ⇒ { apps: { deny: … } }", () => {
    const scope = desktopScopeOf(draftOf({ denyTitles: "命令提示符" }));
    expect(scope).toEqual({ apps: { deny: { titles: ["命令提示符"] } } });
  });

  it("两侧都有内容 ⇒ allow 与 deny 同时出现（键序 allow → deny）", () => {
    const scope = desktopScopeOf(draftOf({ allowExes: "notepad.exe", denyExes: "cmd.exe" }));
    expect(Object.keys((scope.apps ?? {}) as object)).toEqual(["allow", "deny"]);
    expect(scope).toEqual({ apps: { allow: { exes: ["notepad.exe"] }, deny: { exes: ["cmd.exe"] } } });
  });

  it("某侧只填了 titles ⇒ 该侧只有 titles 字段（不产出空的 exes）", () => {
    const scope = desktopScopeOf(draftOf({ allowTitles: "无标题 - 记事本" }));
    expect(scope).toEqual({ apps: { allow: { titles: ["无标题 - 记事本"] } } });
  });
});

describe("M2-B2a 应用清单：分隔与去重（值里的空格不能被切开）", () => {
  it("逗号 / 分号 / 换行 / 全角逗号都能分隔", () => {
    expect(splitAppEntries("a.exe, b.exe;c.exe\nd.exe，e.exe")).toEqual([
      "a.exe",
      "b.exe",
      "c.exe",
      "d.exe",
      "e.exe",
    ]);
  });

  it("**不按空白切**：带空格的路径与窗口标题保持完整", () => {
    expect(splitAppEntries("C:\\Program Files\\App\\a.exe")).toEqual(["C:\\Program Files\\App\\a.exe"]);
    expect(splitAppEntries("另存为 - 记事本")).toEqual(["另存为 - 记事本"]);
  });

  it("逐项 trim 与去重（首现序无关：服务端随后会排序）", () => {
    expect(splitAppEntries("  a.exe , a.exe ,b.exe")).toEqual(["a.exe", "b.exe"]);
  });

  it("空串与纯分隔符 ⇒ 空数组（不是 ['']）", () => {
    expect(splitAppEntries("")).toEqual([]);
    expect(splitAppEntries(" , ; ")).toEqual([]);
  });
});

describe("M2-B2a 应用清单：提交前校验", () => {
  it("正常输入通过", () => {
    expect(validateAppsDraft(draftOf({ allowExes: "notepad.exe" }))).toBeNull();
    expect(validateAppsDraft(emptyAppsDraft())).toBeNull();
  });

  it("疑似凭据被拒（且错误文案不带原文）", () => {
    const err = validateAppsDraft(draftOf({ allowTitles: "Bearer abcdef" }));
    expect(err?.key).toBe("grants.apps.errCredential");
    expect(JSON.stringify(err)).not.toContain("abcdef");
  });

  it("单项超过 200 字符被拒，且与「疑似凭据」不是同一条错误", () => {
    // 两者在服务端是两条不同的 400（entry is longer than … chars / value looks like
    // a credential）；合成一条会让用户按「凭据」去排查一个纯粹太长的值。
    expect(validateAppsDraft(draftOf({ allowExes: "x".repeat(201) }))?.key).toBe("grants.apps.errEntryTooLong");
    expect(validateAppsDraft(draftOf({ allowExes: "sk-abcdef" }))?.key).toBe("grants.apps.errCredential");
  });

  it("每侧超过 32 项被拒", () => {
    const many = Array.from({ length: 33 }, (_, i) => `a${i}.exe`).join(",");
    expect(validateAppsDraft(draftOf({ allowExes: many }))?.key).toBe("grants.apps.errTooLong");
  });
});

describe("M2-B2a 应用清单：回读与摘要", () => {
  it("回读宽松：形状不对当空，绝不抛", () => {
    expect(appsOfScope(undefined)).toEqual({});
    expect(appsOfScope({})).toEqual({});
    expect(appsOfScope({ apps: "not-an-object" } as never)).toEqual({});
    expect(appsOfScope({ apps: { allow: ["a.exe"] } } as never)).toEqual({});
    expect(appsOfScope({ apps: { allow: { exes: ["a.exe", 1, ""] } } } as never)).toEqual({
      allow: { exes: ["a.exe"] },
    });
  });

  it("摘要给出 exe 数 / title 数（两侧分别计数）", () => {
    const apps = appsOfScope({
      apps: { allow: { exes: ["a.exe", "b.exe"], titles: ["t"] }, deny: { exes: ["cmd.exe"] } },
    });
    expect(appsSummary(apps)).toContain("2");
    expect(appsSummary(apps)).toContain("1");
  });

  it("两侧都空 ⇒ 摘要说「不限应用」（**不是**「什么都不允许」）", () => {
    expect(appsSummary({})).toContain("不限应用");
  });
});
