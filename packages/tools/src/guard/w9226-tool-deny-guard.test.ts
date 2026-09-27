/**
 * W9226 · P0 回归：被 `toolDeny` 禁用的工具，**不能**从 `run_code` 程序内调用。
 *
 * 复现的缺陷（修复前实测）：
 *   直调   run_shell => tool_unavailable_in_mode: 'run_shell' is not directly callable  ← 被拒
 *   子调用 run_shell => {"echo":"run_shell","args":{"command":"echo hi"}}            ← 执行了
 *
 * 修法：`toolDeny` 不再只进暴露面，而是**同时**装一条 guard ——
 * guard 在 registry 的 dispatch 里跑，而 broker 的子调用走同一个 registry。
 */
import { afterEach, describe, expect, it } from "vitest";
import { exposedRegistry } from "../exposure.js";
import { startBrokerHarness, type BrokerHarness } from "../run-code/broker.test-util.js";

const harnesses: BrokerHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

describe('W9226 · toolDeny reaches run_code sub-calls', () => {
  it('a DENIED tool is refused from inside run_code, not merely hidden', async () => {
    const h = await startBrokerHarness();
    harnesses.push(h);
    if (!h.nodeReady) { console.log('[W9226] SKIP: node not ready'); return; }

    const inner = h.echoRegistry();
    // The guard the production assembly mounts for `toolDeny`.
    const { toolDenyGuard } = await import("./tool-deny.js");
    inner.addGuard(toolDenyGuard(['run_shell']));
    const tool = h.mount(inner);
    const face = exposedRegistry(inner, { hidden: ['run_shell'] });

    const direct = await face.dispatch({ call_id: 'd1', name: 'run_shell', args: { command: 'echo hi' } });
    console.log('[W9226] DIRECT  =>', (direct.error ?? 'ALLOWED').slice(0, 100));
    expect(direct.error, '直调必须被拒').toBeDefined();

    const out = await h.run(tool, 'rc1', {
      code: 'function main() { try { const r = tools.run_shell({ command: "echo hi" }); return "BYPASSED:" + JSON.stringify(r); } catch (e) { return "REFUSED:" + String(e); } }',
    });
    const value = String((out as { value?: unknown }).value ?? '');
    console.log('[W9226] SUBCALL =>', value.slice(0, 200));
    expect(value, '子调用必须被拒，不得执行').not.toContain('BYPASSED');
    expect(value).toContain('REFUSED');
  }, 120_000);

  it('a tool NOT in the deny list still works from inside run_code (execution mode intact)', async () => {
    const h = await startBrokerHarness();
    harnesses.push(h);
    if (!h.nodeReady) { console.log('[W9226] SKIP: node not ready'); return; }
    const inner = h.echoRegistry();
    const { toolDenyGuard } = await import("./tool-deny.js");
    // Deny only run_shell; read_file must keep working (that is execution mode's point).
    inner.addGuard(toolDenyGuard(['run_shell']));
    const tool = h.mount(inner);
    const out = await h.run(tool, 'rc2', {
      code: 'function main() { const r = tools.read_file({ path: "/tmp/x" }); return "OK:" + JSON.stringify(r); }',
    });
    const value = String((out as { value?: unknown }).value ?? '');
    console.log('[W9226] ALLOWED SUBCALL =>', value.slice(0, 160));
    expect(value, '未禁用的工具必须仍可从程序内调用').toContain('OK:');
  }, 120_000);
});