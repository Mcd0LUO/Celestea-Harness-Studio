// @vitest-environment node
import { describe, expect, it } from "vitest";
import { bounded, createToolRegistry, toolDenyGuard, TOOL_DENIED_CODE } from "@celestea/tools";
import {
  createDesktopGate,
  desktopTools,
  type DesktopGate,
  type DesktopGateCall,
  type DesktopGateGrant,
  type DesktopHelperClient,
} from "@celestea/desktop";

/**
 * M2 真值表的前两行：**preset deny / session deny**（规划 §4.1 第 1、2 层）。
 *
 * 这两层**不在闸门里**，而且必须不在：它们是「按工具名禁用」的既有机制，
 * 落在 `packages/tools/src/plugin.ts` 的 `toolDenyGuard` 上，由
 * `ToolRegistryImpl.dispatch()` 在「schema 校验之后、执行之前」跑（registry.ts:74-78）；
 * 而桌面闸门在 `tool.execute` **内部**（tool.ts::callWrite 的第一行）。两者是
 * 前后两道，不是一道的两半。
 *
 * 所以本文件的断言不是「闸门拒了它」，而是**「闸门根本没被问到」**：guard 命中时
 * `gate.check` 的调用次数必须是 0，helper 一次都不许被碰。这正是规划 §4.4 第一行的
 * 意思（「deny，不启动 helper」）。
 *
 * 为什么 preset 与 session 各写一行：它们进 guard 的路径不同（前者来自权限档位的
 * `toolDeny`，后者来自会话 tools.json 的纯减法），但**汇合点相同**——engine-grants.ts
 * 的 `toolDeny` 是两者的并集（该并集本身已由 permissions-all-paths.test.ts:255 钉住）。
 * 两行因此各自证明「这条来源的名字到得了 guard」，而顺序由第一行之后的控制组证明。
 */

/** 写工具的目标参数（契约里 window 是 required）。 */
const CLICK_ARGS = { window: { app: "notepad.exe", id: 1 } };

/**
 * 一个**碰到就炸**的 helper 客户端。
 *
 * 它是本文件的核心断言装置：两行 deny 都要求 helper 一次都不被调用，所以「被调用」
 * 必须是**响亮**的失败，而不是一个安静地返回成功、让测试照样绿的 stub。
 * （仓内纪律：一个什么都答成功的 stub 比没有 stub 更危险。）
 */
function untouchedClient(): { client: DesktopHelperClient; calls: number } {
  const state = { calls: 0 };
  const boom = (): never => {
    state.calls += 1;
    throw new Error("the helper must never be reached: the deny has to happen before dispatch");
  };
  const client = { callTool: boom, handshake: boom, stop: boom } as unknown as DesktopHelperClient;
  return { client, calls: state.calls };
}

/** 一个记下每次 check 的闸门（真闸门包一层，判定语义不被替身污染）。 */
function spyGate(grants: DesktopGateGrant): { gate: DesktopGate; calls: DesktopGateCall[] } {
  const calls: DesktopGateCall[] = [];
  // W2014：真实原语（本包依赖 tools），与生产同一条路径。
  const inner = createDesktopGate({
    grants: { read: () => grants },
    platform: "win32",
    confirm: null,
    deadline: (work, timeoutMs, onTimeout) => bounded(work, timeoutMs, { mode: "resolve", value: onTimeout }),
  });
  return {
    calls,
    gate: {
      check: (call) => {
        calls.push(call);
        return inner.check(call);
      },
    },
  };
}

/**
 * 一个真的注册表 + 真的 guard 链 + 真的桌面工具。`denied` 就是 engine-grants 交给
 * `packages/tools` 的那张名单（preset 的 toolDeny 与 session 的减法在这里已经是同一个数组）。
 */
function hostOf(denied: readonly string[], grants: DesktopGateGrant) {
  const helper = untouchedClient();
  const spy = spyGate(grants);
  const registry = createToolRegistry(
    desktopTools({ client: helper.client, attachments: null, gate: spy.gate }),
    denied.length === 0 ? [] : [toolDenyGuard(denied)],
  );
  return { registry, spy, helper };
}

const granted: DesktopGateGrant = { desktop: true };

describe("M2 真值表 · 第 1 行 preset deny：闸门之前就被挡下", () => {
  it("a preset-denied desktop tool is refused by name and never reaches the gate or the helper", async () => {
    // 「read-only」档位禁掉写工具，就是这条形状（permissions.ts 的 preset.toolDeny）。
    const h = hostOf(["desktop_click", "desktop_type_text"], granted);
    const out = await h.registry.dispatch({ call_id: "c1", name: "desktop_click", args: CLICK_ARGS });

    expect(out.error).toContain(TOOL_DENIED_CODE);
    expect(out.decision?.kind).toBe("deny");
    // ★ 本行的真值：闸门**一次都没被问**。
    expect(h.spy.calls).toEqual([]);
    expect(h.helper.calls).toBe(0);
    // 而工具**在**注册表里（deny 是运行时的减法，不是注册面的删除）—— 否则这条断言
    // 可能只是「工具没挂」的另一种说法。
    expect(h.registry.names()).toContain("desktop_click");
  });
});

describe("M2 真值表 · 第 2 行 session deny：同一道 guard，不同的来源", () => {
  it("a session-level subtraction is refused the same way, with the same evidence", async () => {
    // 会话 tools.json 的纯减法（store/session-tools.ts）进的就是同一张名单。
    const h = hostOf(["desktop_launch_app"], granted);
    const out = await h.registry.dispatch({ call_id: "c2", name: "desktop_launch_app", args: { app: "notepad.exe" } });

    expect(out.error).toContain(TOOL_DENIED_CODE);
    expect(out.decision?.kind).toBe("deny");
    expect(h.spy.calls).toEqual([]);
    expect(h.helper.calls).toBe(0);
    // 名单里**没**点名的桌面工具照常走闸门：deny 是按名字的减法，不是「桌面面整体关掉」。
    const allowed = await h.registry.dispatch({ call_id: "c3", name: "desktop_click", args: CLICK_ARGS });
    expect(allowed.decision?.kind).toBe("allow");
    expect(h.spy.calls).toHaveLength(1);
  });
});

describe("M2 · 控制组：没有 guard 时同一个调用真的会走到闸门", () => {
  it("proves the two rows above are not vacuous (0 calls means 'denied first', not 'never wired')", async () => {
    const h = hostOf([], granted);
    const out = await h.registry.dispatch({ call_id: "c4", name: "desktop_click", args: CLICK_ARGS });
    // 闸门被问了，而且放行了 —— 所以它确实在这条链上，只是排在 guard 之后。
    expect(h.spy.calls).toEqual([{ method: "click", arguments: CLICK_ARGS }]);
    expect(out.decision?.kind).toBe("allow");
  });

  it("shows the gate's own deny is a DIFFERENT layer: it runs after the guard allows, and refuses without the capability", async () => {
    const h = hostOf(["desktop_type_text"], { desktop: false });
    // 未被禁名的工具 ⇒ 过 guard ⇒ 到闸门 ⇒ 因没有 desktop 能力位而被拒。
    const out = await h.registry.dispatch({ call_id: "c5", name: "desktop_click", args: CLICK_ARGS });
    expect(out.decision?.kind).toBe("allow"); // guard 放行了
    expect(out.error).toBeNull(); // 工具的失败是**结果**不是异常
    expect(out.value).toMatchObject({ ok: false, code: "desktop_cap_not_granted", source: "desktop_gate" });
    expect(h.spy.calls).toHaveLength(1);
    expect(h.helper.calls).toBe(0); // 闸门拒绝 ⇒ helper 一次都不碰
  });
});
