// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createDesktopConfirmLimiter,
  DESKTOP_APP_DENIED_CODE,
  DESKTOP_APP_UNRESOLVED_CODE,
  DESKTOP_CAP_NOT_GRANTED_CODE,
  DESKTOP_CONFIRM_CANCELLED_CODE,
  DESKTOP_CONFIRM_COOLDOWN_CODE,
  DESKTOP_CONFIRM_DENIED_CODE,
  DESKTOP_CONFIRM_FAILED_CODE,
  DESKTOP_CONFIRM_TIMEOUT_CODE,
  DESKTOP_CONFIRM_UNAVAILABLE_CODE,
  DESKTOP_METHOD_UNKNOWN_CODE,
  DESKTOP_READ_ONLY_METHODS,
  DESKTOP_SENSITIVE_METHODS,
  DESKTOP_WRITE_METHODS,
  type DesktopConfirmChannel,
  type DesktopConfirmOutcome,
  type DesktopDeadline,
} from "./gate.js";
import { NOTEPAD, denied, gateWith, testDeadline } from "./gate.test-util.js";

/**
 * M2 闸门矩阵（规划 §4.4 真值表）—— 十态真值表这一片。
 *
 * 夹具（假授权源 + 假确认通道）在 gate.test-util.ts；审查修复的用例（标识符前缀、
 * 双路径、尾随点、标题信任）在 gate-apps.test.ts —— 两片共用同一套夹具，分开只是因为
 * 450 行的文件预算。
 *
 * 矩阵覆盖的每一态都在下面的 describe 标题里点名，测试名里带原因码，便于对着真值表核对。
 *
 * 不在本文件的两态（preset deny / session deny）：那两层跑在闸门**之前**
 * （packages/tools/src/plugin.ts:174 的 toolDenyGuard 挂在 ToolRegistryImpl.dispatch
 * 的 guard 链上），所以断言是「闸门根本没被调用」——它需要真 registry + 真守卫，
 * 落在 packages/runtime/src/desktop-gate-order.test.ts。
 */

describe("M2 gate · the two method tables are the frozen contract shape", () => {
  it("names exactly the read-only four, the write nine and the sensitive three", () => {
    expect([...DESKTOP_READ_ONLY_METHODS].sort()).toEqual(["get_window", "get_window_state", "list_apps", "list_windows"]);
    expect([...DESKTOP_WRITE_METHODS].sort()).toEqual([
      "activate_window", "click", "drag", "launch_app", "perform_secondary_action", "press_key", "scroll", "set_value", "type_text",
    ]);
    expect([...DESKTOP_SENSITIVE_METHODS].sort()).toEqual(["launch_app", "set_value", "type_text"]);
    // 三张表互不相交：一个方法不可能既是只读又是写。
    for (const method of DESKTOP_READ_ONLY_METHODS) expect(DESKTOP_WRITE_METHODS).not.toContain(method);
    for (const method of DESKTOP_SENSITIVE_METHODS) expect(DESKTOP_WRITE_METHODS).toContain(method);
  });
});

describe("M2 gate · 态 1 只读放行（连授权都不看）", () => {
  it("allows every read-only method with no approvedApp, even with no grant at all", async () => {
    const { gate, seen } = gateWith({ grants: { desktop: false } });
    for (const method of DESKTOP_READ_ONLY_METHODS) {
      const verdict = await gate.check({ method, arguments: NOTEPAD });
      // approvedApp 缺席是**语义**：只读面的应用预置是 tool.ts 的 M1 例外，不来自闸门。
      expect(verdict, method).toEqual({ kind: "allow" });
    }
    expect(seen).toEqual([]);
  });
});

describe("M2 gate · 态 2 会话未授予 desktop 能力位", () => {
  it("denies every write method with the authorisation guidance, before asking anyone", async () => {
    const { gate, seen } = gateWith({ grants: { desktop: false } });
    for (const method of DESKTOP_WRITE_METHODS) {
      const { code, reason } = denied(await gate.check({ method, arguments: NOTEPAD }));
      expect(code, method).toBe(DESKTOP_CAP_NOT_GRANTED_CODE);
      // 面向模型的一句话要能据此改计划：点名缺什么、找谁要。
      expect(reason, method).toContain("'desktop' capability");
      expect(reason, method).toContain("Ask the user");
    }
    // 未授权是**判定**，不是「先问人再拒」—— 一次都不该打扰用户。
    expect(seen).toEqual([]);
  });
});

describe("M2 gate · 态 3 授权期内放行（非敏感写）", () => {
  it("allows the six non-sensitive writes and hands the target app to the helper", async () => {
    const { gate, seen } = gateWith();
    const nonSensitive = DESKTOP_WRITE_METHODS.filter((m) => !DESKTOP_SENSITIVE_METHODS.includes(m));
    expect(nonSensitive).toHaveLength(6);
    for (const method of nonSensitive) {
      const verdict = await gate.check({ method, arguments: NOTEPAD });
      expect(verdict, method).toEqual({ kind: "allow", approvedApp: "notepad.exe" });
    }
    expect(seen).toEqual([]);
  });

  it("resolves the target app from the plain 'app' argument when there is no window (launch_app)", async () => {
    // launch_app 是敏感集，所以这里走确认通道；解析结果正是 approvedApp 与请求里的 app。
    const { gate, seen } = gateWith();
    const verdict = await gate.check({ method: "launch_app", arguments: { app: "C:\\Windows\\System32\\notepad.exe" } });
    expect(verdict).toEqual({ kind: "allow", approvedApp: "C:\\Windows\\System32\\notepad.exe" });
    expect(seen[0]?.app).toBe("C:\\Windows\\System32\\notepad.exe");
    expect(seen[0]?.reason).toBe("sensitive_method");
  });
});

describe("M2 gate · 态 4 敏感操作每次确认（批准）", () => {
  it("asks the human every single time for the sensitive three, and allows only on approval", async () => {
    const { gate, seen } = gateWith();
    for (const method of DESKTOP_SENSITIVE_METHODS) {
      const verdict = await gate.check({ method, arguments: NOTEPAD });
      expect(verdict, method).toEqual({ kind: "allow", approvedApp: "notepad.exe" });
      // 同一个方法连问两次 = 两次都问（「每次调用」的语义，不是「每会话一次」）。
      await gate.check({ method, arguments: NOTEPAD });
    }
    expect(seen.map((r) => r.method)).toEqual(["type_text", "type_text", "set_value", "set_value", "launch_app", "launch_app"]);
    expect(seen.every((r) => r.reason === "sensitive_method")).toBe(true);
    expect(seen.every((r) => r.timeoutMs === 60_000)).toBe(true);
  });
});

describe("M2 gate · 态 5 拒绝", () => {
  it("denies with a distinct code and a sentence the model can act on", async () => {
    const { gate } = gateWith({ answer: () => "deny" });
    const { code, reason } = denied(await gate.check({ method: "type_text", arguments: NOTEPAD }));
    expect(code).toBe(DESKTOP_CONFIRM_DENIED_CODE);
    expect(reason).toContain("declined");
    expect(reason).toContain("notepad.exe");
    expect(reason).toContain("Do not retry");
  });
});

describe("M2 gate · 态 6 超时（fail-closed）", () => {
  it("denies when nobody answers inside the budget, and does not wait for the channel", async () => {
    // 通道永不 settle：闸门自己的兜底计时必须赢。预算压到 30ms，真实时钟。
    const never: DesktopConfirmChannel = { confirm: () => new Promise<DesktopConfirmOutcome>(() => {}) };
    const { gate } = gateWith({ channel: never, timeoutMs: 30 });
    const started = Date.now();
    const { code, reason } = denied(await gate.check({ method: "set_value", arguments: NOTEPAD }));
    expect(code).toBe(DESKTOP_CONFIRM_TIMEOUT_CODE);
    expect(reason).toContain("nobody answered");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("takes the channel's own 'timeout' report at face value (the transport expires first)", async () => {
    // 传输也按同一个预算 park（UI 要倒计时），它的定时器可能先到。那一种必须报
    // 「没人答」，而不是把空答案伪装成一次拒绝。
    const { gate } = gateWith({ answer: () => "timeout" });
    const { code, reason } = denied(await gate.check({ method: "launch_app", arguments: { app: "notepad.exe" } }));
    expect(code).toBe(DESKTOP_CONFIRM_TIMEOUT_CODE);
    expect(reason).not.toContain("declined");
  });

  it("hands the race to the injected deadline port (the gate owns no timer of its own)", async () => {
    // W2014 的语义面：闸门不再自己 `Promise.race`，而是把**预算**原样交给注入的原语。
    // 这条断言钉的就是那个交接 —— 少了它，「改用统一原语」可以退化成「换个地方写 race」。
    const budgets: number[] = [];
    const spy: DesktopDeadline = (work, timeoutMs, onTimeout) => {
      budgets.push(timeoutMs);
      return testDeadline(work, timeoutMs, onTimeout);
    };
    const { gate } = gateWith({ answer: () => "timeout", deadline: spy });
    expect(denied(await gate.check({ method: "type_text", arguments: NOTEPAD })).code).toBe(DESKTOP_CONFIRM_TIMEOUT_CODE);
    expect(budgets).toEqual([60_000]);
    // 覆盖预算也原样透传（宿主可压小它）。
    const { gate: tight } = gateWith({ answer: () => "timeout", timeoutMs: 30, deadline: spy });
    expect(denied(await tight.check({ method: "type_text", arguments: NOTEPAD })).code).toBe(DESKTOP_CONFIRM_TIMEOUT_CODE);
    expect(budgets).toEqual([60_000, 30]);
  });
});

describe("M2 gate · 态 7 取消（与拒绝分开的原因码）", () => {
  it("denies with the cancelled code when the channel reports a cancellation", async () => {
    const { gate } = gateWith({ answer: () => "cancelled" });
    const { code, reason } = denied(await gate.check({ method: "type_text", arguments: NOTEPAD }));
    expect(code).toBe(DESKTOP_CONFIRM_CANCELLED_CODE);
    expect(reason).toContain("cancelled");
    // 与「拒绝」是两个码：一个是被拒（别照原样重试），一个是被取消（没被拒过）。
    expect(code).not.toBe(DESKTOP_CONFIRM_DENIED_CODE);
  });

  it("treats a channel that THROWS as fail-closed, with its own code (a broken channel is not a denial)", async () => {
    const { gate } = gateWith({ channel: { confirm: () => Promise.reject(new Error("transport gone")) } });
    const { code } = denied(await gate.check({ method: "type_text", arguments: NOTEPAD }));
    expect(code).toBe(DESKTOP_CONFIRM_FAILED_CODE);
  });
});

describe("M2 gate · 态 8 连续三次拒绝进 5 分钟冷却", () => {
  it("enters the cooldown after three consecutive denials and refuses without asking again", async () => {
    let clock = 1_000_000;
    const limiter = createDesktopConfirmLimiter({ now: () => clock });
    const { gate, seen } = gateWith({ answer: () => "deny", limiter, now: () => clock });
    for (let i = 0; i < 3; i++) {
      expect(denied(await gate.check({ method: "type_text", arguments: NOTEPAD })).code).toBe(DESKTOP_CONFIRM_DENIED_CODE);
    }
    expect(seen).toHaveLength(3);
    const cooling = denied(await gate.check({ method: "type_text", arguments: NOTEPAD }));
    expect(cooling.code).toBe(DESKTOP_CONFIRM_COOLDOWN_CODE);
    expect(cooling.reason).toContain("300s");
    // 冷却期内一次都不再打扰用户。
    expect(seen).toHaveLength(3);
    // 冷却结束后重新开始问人，且计数已归零 —— 还要再拒**三次**才重新进冷却。
    // （第三次本身仍报 denied：冷却是在这一次拒绝**记下之后**才对下一次生效的，
    //   与 grants-tokens.ts::GrantRateLimiter 的口径一致。）
    clock += 5 * 60_000 + 1;
    for (let i = 0; i < 3; i++) {
      expect(denied(await gate.check({ method: "type_text", arguments: NOTEPAD })).code).toBe(DESKTOP_CONFIRM_DENIED_CODE);
    }
    expect(denied(await gate.check({ method: "type_text", arguments: NOTEPAD })).code).toBe(DESKTOP_CONFIRM_COOLDOWN_CODE);
  });

  it("counts only explicit denials: an approval clears the streak, a timeout does not add to it", async () => {
    let clock = 0;
    const limiter = createDesktopConfirmLimiter({ now: () => clock });
    limiter.record("deny");
    limiter.record("deny");
    limiter.record("approve");
    limiter.record("deny");
    limiter.record("deny");
    // 超时/取消不算「用户拒绝」——用户可能只是没看见，不该把他锁在冷却里。
    limiter.record("timeout");
    limiter.record("cancelled");
    expect(limiter.cooldownRemainingMs()).toBe(0);
    limiter.record("deny");
    expect(limiter.cooldownRemainingMs()).toBe(5 * 60_000);
    clock += 5 * 60_000;
    expect(limiter.cooldownRemainingMs()).toBe(0);
  });
});

describe("M2 gate · 态 9 apps deny 命中（deny 永远赢）", () => {
  it("denies before anything else — even for a non-sensitive method, and even with no grant at all", async () => {
    const apps = { deny: { exes: ["notepad.exe"] } };
    const withGrant = gateWith({ grants: { desktop: true, apps } });
    const { code, reason } = denied(await withGrant.gate.check({ method: "click", arguments: NOTEPAD }));
    expect(code).toBe(DESKTOP_APP_DENIED_CODE);
    expect(reason).toContain("notepad.exe");
    // 命中条目本身要出现在 reason 里（规划 §4.4：「deny + 命中条目」）。
    expect(reason).toContain("entry 'notepad.exe'");
    // 没有授权也一样是 apps deny：清单是天花板，先判它。
    const noGrant = gateWith({ grants: { desktop: false, apps } });
    expect(denied(await noGrant.gate.check({ method: "click", arguments: NOTEPAD })).code).toBe(DESKTOP_APP_DENIED_CODE);
    // deny 压过 allow：同一条目同时出现在两侧时，deny 赢。
    const both = gateWith({ grants: { desktop: true, apps: { allow: { exes: ["notepad.exe"] }, deny: { exes: ["notepad.exe"] } } } });
    expect(denied(await both.gate.check({ method: "click", arguments: NOTEPAD })).code).toBe(DESKTOP_APP_DENIED_CODE);
  });

  it("matches an exe by basename (a full path in the call still hits a bare-name deny entry)", async () => {
    const { gate } = gateWith({ grants: { desktop: true, apps: { deny: { exes: ["notepad.exe"] } } } });
    const { code } = denied(await gate.check({ method: "click", arguments: { window: { app: "C:\\Windows\\System32\\NOTEPAD.EXE", id: 3 } } }));
    expect(code).toBe(DESKTOP_APP_DENIED_CODE);
  });

  it("matches a title entry against the HELPER's title (the model's window.title is display-only)", async () => {
    const realTitles: Record<number, string> = { 1: "secret notes", 2: "Docs" };
    const { gate } = gateWith({
      grants: { desktop: true, apps: { deny: { titles: ["Secret Notes"] } } },
      titleResolver: (t) => Promise.resolve(realTitles[t.windowId] ?? null),
    });
    // 真标题命中 ⇒ 拒（大小写按平台折叠）。
    expect(denied(await gate.check({ method: "click", arguments: { window: { app: "notepad.exe", id: 1, title: "随便写的" } } })).code).toBe(
      DESKTOP_APP_DENIED_CODE,
    );
    // ★ 模型**声明**了被禁的标题，而真标题不是它 ⇒ 放行（证明声明不参与判定）。
    expect((await gate.check({ method: "click", arguments: { window: { app: "chrome.exe", id: 2, title: "secret notes" } } })).kind).toBe("allow");
  });
});

describe("M2 gate · 态 10 apps allow 非空未命中 → 升级确认", () => {
  it("escalates a non-sensitive method on an unlisted app to a per-call confirmation", async () => {
    const apps = { allow: { exes: ["chrome.exe"] } };
    const { gate, seen } = gateWith({ grants: { desktop: true, apps } });
    // 「升级为确认」的证据是**人真的被问了**，且批准后放行 —— 不是「被拒」。
    expect(await gate.check({ method: "click", arguments: NOTEPAD })).toEqual({ kind: "allow", approvedApp: "notepad.exe" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.reason).toBe("app_not_allowlisted");
    expect(seen[0]?.app).toBe("notepad.exe");
    // 命中 allow 的应用不打扰用户。
    expect(await gate.check({ method: "click", arguments: { window: { app: "chrome.exe", id: 9 } } })).toEqual({ kind: "allow", approvedApp: "chrome.exe" });
    expect(seen).toHaveLength(1);
    // 同一个未列名的应用，人说不 —— 走的就是普通确认拒绝那条路。
    const refusing = gateWith({ grants: { desktop: true, apps }, answer: () => "deny" });
    expect(denied(await refusing.gate.check({ method: "click", arguments: NOTEPAD })).code).toBe(DESKTOP_CONFIRM_DENIED_CODE);
    expect(refusing.seen[0]?.reason).toBe("app_not_allowlisted");
  });

  it("treats an empty allow list as 'no restriction' (规划 §4.3), not as 'deny everything'", async () => {
    const { gate, seen } = gateWith({ grants: { desktop: true, apps: { allow: { exes: [], titles: [] }, deny: { exes: [] } } } });
    expect(await gate.check({ method: "click", arguments: NOTEPAD })).toEqual({ kind: "allow", approvedApp: "notepad.exe" });
    expect(seen).toEqual([]);
  });
});

describe("M2 gate · fail-closed 的其余入口", () => {
  it("refuses a method it does not know instead of guessing it is harmless", async () => {
    const { gate } = gateWith();
    const { code } = denied(await gate.check({ method: "reboot_the_machine", arguments: NOTEPAD }));
    expect(code).toBe(DESKTOP_METHOD_UNKNOWN_CODE);
  });

  it("refuses a write whose target app cannot be resolved (no helper-side approval can be produced)", async () => {
    const { gate } = gateWith();
    for (const args of [{}, { window: {} }, { window: { id: 3 } }, { app: "   " }]) {
      const { code } = denied(await gate.check({ method: "click", arguments: args }));
      expect(code, JSON.stringify(args)).toBe(DESKTOP_APP_UNRESOLVED_CODE);
    }
  });

  it("refuses a confirmation-needing call when this host has no confirmation channel", async () => {
    const { gate } = gateWith({ channel: null });
    const { code, reason } = denied(await gate.check({ method: "type_text", arguments: NOTEPAD }));
    expect(code).toBe(DESKTOP_CONFIRM_UNAVAILABLE_CODE);
    expect(reason).toContain("no confirmation channel");
    // 非敏感写不需要通道，仍然放行 —— 「没通道」不等于「桌面面整体不可用」。
    expect((await gate.check({ method: "click", arguments: NOTEPAD })).kind).toBe("allow");
  });

  it("folds case on win32 only (POSIX exe names are case-sensitive)", async () => {
    const apps = { deny: { exes: ["notepad.exe"] } };
    const win = gateWith({ grants: { desktop: true, apps }, platform: "win32" });
    expect(denied(await win.gate.check({ method: "click", arguments: { window: { app: "NOTEPAD.EXE", id: 1 } } })).code).toBe(DESKTOP_APP_DENIED_CODE);
    const posix = gateWith({ grants: { desktop: true, apps }, platform: "linux" });
    expect((await posix.gate.check({ method: "click", arguments: { window: { app: "NOTEPAD.EXE", id: 1 } } })).kind).toBe("allow");
  });

  it("re-reads the grant on every call, so a revocation lands without rebuilding the gate", async () => {
    const { gate, set } = gateWith();
    expect((await gate.check({ method: "click", arguments: NOTEPAD })).kind).toBe("allow");
    set({ desktop: false });
    expect(denied(await gate.check({ method: "click", arguments: NOTEPAD })).code).toBe(DESKTOP_CAP_NOT_GRANTED_CODE);
  });
});