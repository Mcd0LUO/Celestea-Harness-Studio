/**
 * W9226 · **端到端**：走真实的 `assembleTools({grants:{toolDeny}})` 装配，
 * 而不是手工 `addGuard`。这验的是「接线」而不是「守卫本身」。
 */
import { afterEach, describe, expect, it } from "vitest";
import { assembleTools } from "../plugin.js";
import { startBrokerHarness, type BrokerHarness } from "../run-code/broker.test-util.js";

const harnesses: BrokerHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

describe('W9226 · production wiring (assembleTools + grants.toolDeny)', () => {
  it('grants.toolDeny is enforced on sub-calls through the real assembly', async () => {
    const h = await startBrokerHarness();
    harnesses.push(h);
    if (!h.nodeReady) { console.log('[W9226] SKIP: node not ready'); return; }

    const assembly = assembleTools({
      sandbox: h.sandbox,
      env: {},
      guard: null,            // isolate: only the toolDeny guard is under test
      tools: h.echoRegistry().names().map((n) => h.echoRegistry().get(n)!),
      grants: { toolDeny: ['run_shell'] },
    });
    const runCode = assembly.registry.get('run_code');
    if (runCode?.executeWith === undefined) { console.log('[W9226] SKIP: run_code not mounted'); return; }

    const out = await runCode.executeWith({
      call_id: 'e2e1', name: 'run_code', args: {
        code: 'function main() { try { const r = tools.run_shell({ command: "echo hi" }); return "BYPASSED:" + JSON.stringify(r); } catch (e) { return "REFUSED:" + String(e); } }',
      },
    });
    const value = String((out as { value?: unknown }).value ?? '');
    console.log('[W9226-E2E] =>', value.slice(0, 220));
    expect(value, '生产装配必须拦住子调用').not.toContain('BYPASSED');
    expect(value).toContain('REFUSED');
  }, 120_000);
});