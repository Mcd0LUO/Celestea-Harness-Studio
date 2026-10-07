// @vitest-environment node
/**
 * M2 闸门 · fresh-eyes 审查修复的回归（四条：标识符前缀 / 双路径 / 尾随点 / 标题信任）。
 *
 * 与 gate.test.ts 分片的理由只是 450 行的文件预算；夹具共用 gate.test-util.ts，
 * 十态真值表仍在 gate.test.ts。
 *
 * 四条都钉**后果**（一条 deny 规则能不能被绕过、一次确认会不会被跳过），不钉实现写法；
 * 每条都做过变异负控制（改坏实现确认变红再还原），见交付回报。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_APP_DENIED_CODE,
  DESKTOP_APP_ID_PREFIXES,
  DESKTOP_SHELL_APPSFOLDER_PREFIXES,
  DESKTOP_TITLE_UNRESOLVED_CODE,
  type DesktopTitleResolver,
} from "./gate.js";
import { denied, gateWith } from "./gate.test-util.js";
describe("M2 gate · 审查修复① 标识符前缀（helper 剥前缀后真的会执行）", () => {
  it("hits a bare deny entry through every official prefix and the quoted/padded variants", async () => {
    const { gate } = gateWith({ grants: { desktop: true, apps: { deny: { exes: ["cmd.exe"] } } } });
    const forms = [
      "cmd.exe",
      "process:cmd.exe",
      "path:cmd.exe",
      "registry:cmd.exe",
      "app-user-model-id:cmd.exe",
      "window-app:cmd.exe",
      '\"process:cmd.exe\"',
      "  process:cmd.exe  ",
      "process:C:\\Windows\\System32\\cmd.exe",
    ];
    for (const form of forms) {
      const verdict = await gate.check({ method: "click", arguments: { window: { app: form, id: 1 } } });
      expect(denied(verdict).code, form).toBe(DESKTOP_APP_DENIED_CODE);
    }
    // 反向：别的程序不受影响（证明上面不是「一律拒绝」）。
    expect((await gate.check({ method: "click", arguments: { window: { app: "process:notepad.exe", id: 1 } } })).kind).toBe("allow");
  });

  it("covers the shell:AppsFolder namespace too (that is launch_app's app form)", async () => {
    const { gate } = gateWith({ grants: { desktop: true, apps: { deny: { exes: ["cmd.exe"] } } } });
    for (const form of ["shell:AppsFolder\\cmd.exe", "shell:appsfolder/cmd.exe", '\"shell:AppsFolder\\cmd.exe\"']) {
      expect(denied(await gate.check({ method: "launch_app", arguments: { app: form } })).code, form).toBe(DESKTOP_APP_DENIED_CODE);
    }
    // ★ 上面三条其实**证明不了** shell 前缀被剥掉了：叶名兜底会替它们命中。
    //   真正的判别式是「deny 写全路径」：那时两侧都不是裸名，叶名兜底不生效，
    //   只有把 shell 前缀剥掉才能整串相等。变异负控制就是靠这条抓到那个假通过的。
    const fullPath = gateWith({ grants: { desktop: true, apps: { deny: { exes: ["C:\\Windows\\System32\\cmd.exe"] } } } });
    for (const form of ["shell:AppsFolder\\C:\\Windows\\System32\\cmd.exe", "shell:appsfolder/C:\\Windows\\System32\\cmd.exe"]) {
      expect(denied(await fullPath.gate.check({ method: "launch_app", arguments: { app: form } })).code, form).toBe(DESKTOP_APP_DENIED_CODE);
    }
    // 同理，官方前缀也要一条「全路径 deny」的判别式（叶名兜底同样会掩盖它）。
    const official = gateWith({ grants: { desktop: true, apps: { deny: { exes: ["C:\\Windows\\System32\\cmd.exe"] } } } });
    for (const form of ["process:C:\\Windows\\System32\\cmd.exe", "path:C:\\Windows\\System32\\cmd.exe", '\"window-app:C:\\Windows\\System32\\cmd.exe\"']) {
      expect(denied(await official.gate.check({ method: "click", arguments: { window: { app: form, id: 1 } } })).code, form).toBe(DESKTOP_APP_DENIED_CODE);
    }
  });

  it("keeps the prefix tables in lockstep with the helper source (mechanical drift guard)", () => {
    // 真源是 helper 的 Rust 源码；本用例**读它**再比对，所以少抄一个前缀会在这里红。
    const root = process.cwd();
    const enumRs = readFileSync(join(root, "packages/desktop/helper/src/enum_windows.rs"), "utf8");
    const declared = /pub const APP_ID_PREFIXES[^=]*=\s*&\[([\s\S]*?)\];/.exec(enumRs);
    expect(declared, "找不到 enum_windows.rs::APP_ID_PREFIXES").not.toBeNull();
    const rust = [...(declared as RegExpExecArray)[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect([...DESKTOP_APP_ID_PREFIXES].sort()).toEqual(rust.sort());

    const catalogRs = readFileSync(join(root, "packages/desktop/helper/src/app_catalog.rs"), "utf8");
    const shell = /fn strip_known_prefixes[\s\S]*?for prefix in \[([^\]]*)\]/.exec(catalogRs);
    expect(shell, "找不到 app_catalog.rs::strip_known_prefixes 的 shell 前缀表").not.toBeNull();
    const rustShell = [...(shell as RegExpExecArray)[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.toLowerCase());
    expect([...DESKTOP_SHELL_APPSFOLDER_PREFIXES].sort()).toEqual(rustShell.sort());
  });
});

describe("M2 gate · 审查修复② 双路径不得回退 basename（CW-5）", () => {
  it("keeps two same-named executables in different directories distinguishable", async () => {
    const { gate } = gateWith({ grants: { desktop: true, apps: { deny: { exes: ["D:\\Untrusted\\app.exe"] } } } });
    // ★ 双端都是路径 ⇒ 必须折叠后整串相等；叶名相同**不算**命中（否则白名单被扩大）。
    expect((await gate.check({ method: "click", arguments: { window: { app: "C:\\Trusted\\app.exe", id: 1 } } })).kind).toBe("allow");
    expect(denied(await gate.check({ method: "click", arguments: { window: { app: "D:\\Untrusted\\app.exe", id: 1 } } })).code).toBe(DESKTOP_APP_DENIED_CODE);
    // 裸名一侧仍然回退 —— 那是 helper 明确保留的兼容档（面板里多半填裸名）。
    const bare = gateWith({ grants: { desktop: true, apps: { deny: { exes: ["app.exe"] } } } });
    expect(denied(await bare.gate.check({ method: "click", arguments: { window: { app: "C:\\Trusted\\app.exe", id: 1 } } })).code).toBe(DESKTOP_APP_DENIED_CODE);
  });

  it("does not widen an allow list either (the same rule protects both sides)", async () => {
    const { gate, seen } = gateWith({ grants: { desktop: true, apps: { allow: { exes: ["C:\\Trusted\\app.exe"] } } } });
    // 同名的另一个目录**不**算命中 allow ⇒ 升级为确认，而不是静默放行。
    expect(await gate.check({ method: "click", arguments: { window: { app: "D:\\Untrusted\\app.exe", id: 1 } } })).toEqual({ kind: "allow", approvedApp: "D:\\Untrusted\\app.exe" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.reason).toBe("app_not_allowlisted");
    // 命中 allow 的那个不打扰用户。
    expect(await gate.check({ method: "click", arguments: { window: { app: "C:\\Trusted\\app.exe", id: 1 } } })).toEqual({ kind: "allow", approvedApp: "C:\\Trusted\\app.exe" });
    expect(seen).toHaveLength(1);
  });
});

describe("M2 gate · 审查修复③ 尾随点与重复分隔符", () => {
  it("normalizes the Windows-equivalent spellings of the same executable", async () => {
    const { gate } = gateWith({ grants: { desktop: true, apps: { deny: { exes: ["notepad.exe"] } } } });
    for (const form of ["notepad.exe.", "NOTEPAD.EXE.", "C:\\Windows\\notepad.exe.", "C:\\\\Windows\\\\notepad.exe", "C:/Windows/notepad.exe"]) {
      expect(denied(await gate.check({ method: "click", arguments: { window: { app: form, id: 1 } } })).code, form).toBe(DESKTOP_APP_DENIED_CODE);
    }
    // 全路径条目同样受益：重复分隔符/尾随点不该让它失效。
    const full = gateWith({ grants: { desktop: true, apps: { deny: { exes: ["C:\\Windows\\notepad.exe"] } } } });
    expect(denied(await full.gate.check({ method: "click", arguments: { window: { app: "c:\\\\WINDOWS\\\\notepad.exe.", id: 1 } } })).code).toBe(DESKTOP_APP_DENIED_CODE);
  });
});

describe("M2 gate · 审查修复④ titles 必须用 helper 的真实标题", () => {
  it("a forged title cannot bypass deny.titles", async () => {
    const { gate } = gateWith({
      grants: { desktop: true, apps: { deny: { titles: ["Secret Notes"] } } },
      titleResolver: () => Promise.resolve("Secret Notes"),
    });
    // 模型把标题伪造成无害的东西 —— 判定看的是解析器给的标题。
    expect(denied(await gate.check({ method: "click", arguments: { window: { app: "notepad.exe", id: 1, title: "Untitled" } } })).code).toBe(
      DESKTOP_APP_DENIED_CODE,
    );
    // 连「省略 title」也一样（旧实现里省略就能绕过）。
    expect(denied(await gate.check({ method: "click", arguments: { window: { app: "notepad.exe", id: 1 } } })).code).toBe(DESKTOP_APP_DENIED_CODE);
  });

  it("a forged title cannot skip the allow.titles confirmation", async () => {
    const { gate, seen } = gateWith({
      grants: { desktop: true, apps: { allow: { titles: ["Trusted Doc"] } } },
      titleResolver: () => Promise.resolve("Untrusted Page"),
    });
    // 声明命中 allow 的标题，真标题不命中 ⇒ 仍然要问人（不再免确认）。
    expect(await gate.check({ method: "click", arguments: { window: { app: "chrome.exe", id: 3, title: "Trusted Doc" } } })).toEqual({
      kind: "allow",
      approvedApp: "chrome.exe",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.reason).toBe("app_not_allowlisted");
  });

  it("uses the resolved title for the card, and the claimed one only when nothing was resolved", async () => {
    const resolved = gateWith({
      grants: { desktop: true, apps: { deny: { titles: ["nope"] } } },
      titleResolver: () => Promise.resolve("Real Title"),
    });
    await resolved.gate.check({ method: "type_text", arguments: { window: { app: "notepad.exe", id: 1, title: "Claimed" } } });
    expect(resolved.seen[0]?.title).toBe("Real Title");
    // 没有 titles 清单 ⇒ 不解析，卡片沿用模型声明的那一个（显示用途）。
    const noTitles = gateWith();
    await noTitles.gate.check({ method: "type_text", arguments: { window: { app: "notepad.exe", id: 1, title: "Claimed" } } });
    expect(noTitles.seen[0]?.title).toBe("Claimed");
  });

  it("is fail-closed when the real title cannot be read while a titles list exists", async () => {
    for (const resolver of [undefined, () => Promise.resolve(null), () => Promise.resolve("   "), () => Promise.reject(new Error("helper down"))]) {
      const { gate, seen } = gateWith({
        grants: { desktop: true, apps: { deny: { titles: ["Secret Notes"] } } },
        ...(resolver === undefined ? {} : { titleResolver: resolver as DesktopTitleResolver }),
      });
      const { code } = denied(await gate.check({ method: "click", arguments: { window: { app: "notepad.exe", id: 1 } } }));
      expect(code).toBe(DESKTOP_TITLE_UNRESOLVED_CODE);
      // 关键：**不是**升级为确认 —— 一次点击不能替代一次没做成的检查。
      expect(seen).toEqual([]);
    }
    // 窗口 id 缺失（畸形调用）同样落在这里，而不是「跳过标题检查」。
    const noId = gateWith({ grants: { desktop: true, apps: { deny: { titles: ["x"] } } }, titleResolver: () => Promise.resolve("x") });
    expect(denied(await noId.gate.check({ method: "click", arguments: { window: { app: "notepad.exe" } } })).code).toBe(DESKTOP_TITLE_UNRESOLVED_CODE);
  });

  it("leaves the model's title out of the decision entirely when no titles list exists", async () => {
    // 现状行为不变：没有 titles 条目 ⇒ 标题不参与判定，也不去解析。
    let asked = 0;
    const { gate } = gateWith({ titleResolver: () => { asked += 1; return Promise.resolve("anything"); } });
    expect((await gate.check({ method: "click", arguments: { window: { app: "notepad.exe", id: 1, title: "Secret Notes" } } })).kind).toBe("allow");
    expect(asked).toBe(0);
  });

  it("does not apply titles to launch_app (it has no target window) but still checks its exe", async () => {
    const { gate, seen } = gateWith({
      grants: { desktop: true, apps: { deny: { titles: ["Secret Notes"] } } },
      titleResolver: () => Promise.resolve(null),
    });
    // 没有目标窗口 ⇒ titles 不适用，敏感集照常问人（而不是被 title 未解析拒掉）。
    expect(await gate.check({ method: "launch_app", arguments: { app: "notepad.exe" } })).toEqual({ kind: "allow", approvedApp: "notepad.exe" });
    expect(seen).toHaveLength(1);
    // exe 检查照旧：deny.exes 仍然命中（前缀/尾随点变体也在内）。
    const deniedApp = gateWith({ grants: { desktop: true, apps: { deny: { exes: ["cmd.exe"] } } } });
    expect(denied(await deniedApp.gate.check({ method: "launch_app", arguments: { app: "process:cmd.exe." } })).code).toBe(DESKTOP_APP_DENIED_CODE);
  });
});
