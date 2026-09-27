/**
 * W9228 · W9225 F-09 的生产半边：重复塌陷的**唯一存活记录**必须真的产生。
 *
 * 审计原文（results/W9208-core与llm.md:206-235）：`repetitionDiagnostics` 在全仓
 * 只有 loop.ts 的声明与单测的用例，**没有任何 host 传入**，于是生产路径恒有
 * `this.diagnostics === null` ⇒ `CollapseDriver.log()` 第一行就 return：
 * 既不写 `repetitions.jsonl`，也不写被丢弃文本的副本，而重复塌陷会**丢弃整段模型
 * 输出**。这与 repetition-recovery.ts 的承诺（"the ONLY surviving record"）直接矛盾。
 *
 * 本文件跑**真实装配**：与 `repetition-host.test.ts` 同一个 `SessionComposer`，
 * 同一个 `createOfflineLlm`，模型 id 落在 DeepSeek 家族（守卫唯一启用的范围），
 * 让一轮真的塌陷，然后断言会话目录里出现了那份记录。
 *
 * 判据刻意用**文件系统事实**（文件存在 + JSONL 行可解析 + sessionId 正确），
 * 不复制 `recordRepetition` 的实现逻辑。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Llm } from "@celestea/core";
import type { Profile } from "@celestea/runtime";
import { sessionWorkspaceOf } from "../store/sessions.js";
import type { StudioHarness } from "../harness.test-util.js";
import { createOfflineLlm } from "./offline-llm.js";
import { SessionComposer, REPETITION_COPY_DIRNAME, REPETITION_LOG_NAME } from "./session-compose.js";
import type { SessionTarget } from "./engine-session.js";
import { makeEngineHarness } from "./test-util.js";

const harnesses: StudioHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** DeepSeek 家族 id —— 守卫只对它们启用（repetition.ts 的 isDeepSeekModel）。 */
const PROFILE: Profile = {
  model: "deepseek-flash",
  base_url: "http://127.0.0.1:9/v1",
  api_key_env: "CELESTEA_API_KEY",
  api_key_file: null,
  max_steps: 4096,
  max_parallel_tool_calls: 4,
  reasoning_effort: "max",
  max_output_tokens: null,
  context_window_tokens: 1_000_000,
  system_prompt: "engine identity prompt",
  request_format: "chat_completions",
  temperature: null,
};

/** 生产里真实观测到的塌陷形状（与 repetition-loop.test.ts 的 COLLAPSE 同源）。 */
const COLLAPSE = "OK. Let me write. Let me go. ".repeat(200);
/** 重发后的健康答案：让这一轮以 completed 收尾（重试臂走通）。 */
const HEALTHY = Array.from(
  { length: 60 },
  (_, i) => `Point ${i} records a distinct, verified observation about module ${i}.`,
).join(" ");

function composerOver(h: StudioHarness, llm: (profile: Profile) => Llm): SessionComposer {
  const services = h.studio.services;
  return new SessionComposer({
    env: {},
    baseProfile: () => PROFILE,
    llm,
    workers: false,
    ledgerFile: null,
    resolveSession: (id): SessionTarget | null => {
      const resolved = services.sessions.resolve(id);
      return resolved.ok ? { sessionId: id, dir: resolved.value.dir, workspace: sessionWorkspaceOf(resolved.value) } : null;
    },
  });
}

/**
 * 等一个条件成立（诊断写盘是 fire-and-forget：`recordRepetition` 不 await，
 * 所以「文件存在」会早于「内容写完」）。
 *
 * 这里等的是**内容**而不是存在性 —— 只等存在性会在 appendFile 刚建好空文件时
 * 就返回（实测踩到：`lines.length` 读到 0）。这是等一个真实异步副作用，
 * 不是放宽断言：超时后条件仍不成立 ⇒ 失败。
 */
async function until(cond: () => boolean, ms = 4_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (cond()) return true;
    if (Date.now() >= deadline) return cond();
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 该 JSONL 文件里已落盘的非空行数（文件不存在 ⇒ 0）。 */
function logLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
}

describe("W9228 · F-09 重复塌陷的唯一存活记录在生产装配下真的产生", () => {
  it("一轮塌陷 ⇒ 会话目录里出现 repetitions.jsonl，且记录指名本会话", async () => {
    const h = makeEngineHarness({ sessions: { s1: [] } });
    harnesses.push(h);
    const dir = join(h.workspace, "s1");
    const script = [{ text: COLLAPSE }, { text: HEALTHY }];
    const composer = composerOver(h, () => createOfflineLlm({ script, chunkChars: 24 }));
    const rt = composer.compose("sample-ws/s1", dir);
    try {
      await rt.runTurn("go");
    } finally {
      await rt.shutdown();
    }

    const logPath = join(dir, REPETITION_LOG_NAME);
    expect(await until(() => logLines(logPath).length > 0), "重复塌陷必须留下 repetitions.jsonl（修复前永不产生）").toBe(true);
    const lines = logLines(logPath);
    expect(lines.length, "至少一条定罪记录").toBeGreaterThan(0);
    const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(first["event"]).toBe("repetition-detected");
    expect(first["action"], "第一次定罪走 discard-and-retry 臂").toBe("discard-and-retry");
    expect(first["sessionId"], "记录必须指名会话，而不是 null").toBe("sample-ws/s1");
    expect(first["model"]).toBe("deepseek-flash");
  });

  it("被丢弃的文本有副本落盘（那是『丢了什么』的唯一证据）", async () => {
    const h = makeEngineHarness({ sessions: { s2: [] } });
    harnesses.push(h);
    const dir = join(h.workspace, "s2");
    const composer = composerOver(h, () => createOfflineLlm({ script: [{ text: COLLAPSE }, { text: HEALTHY }], chunkChars: 24 }));
    const rt = composer.compose("sample-ws/s2", dir);
    try {
      await rt.runTurn("go");
    } finally {
      await rt.shutdown();
    }

    const copyDir = join(dir, REPETITION_COPY_DIRNAME);
    expect(await until(() => existsSync(copyDir) && readdirSync(copyDir).length > 0), "副本必须产生").toBe(true);
    const copies = readdirSync(copyDir);
    expect(copies.length, "至少一份丢弃文本的副本").toBeGreaterThan(0);
    expect(copies[0]).toMatch(/\.txt$/);
    const text = readFileSync(join(copyDir, copies[0]!), "utf8");
    expect(text.length, "副本不是空文件").toBeGreaterThan(0);
    expect(text).toContain("Let me go");
  });

  it("健康轮（无塌陷）不产生任何 sidecar（诊断不得变成噪声）", async () => {
    const h = makeEngineHarness({ sessions: { s3: [] } });
    harnesses.push(h);
    const dir = join(h.workspace, "s3");
    const composer = composerOver(h, () => createOfflineLlm({ script: [{ text: HEALTHY }] }));
    const rt = composer.compose("sample-ws/s3", dir);
    try {
      await rt.runTurn("go");
    } finally {
      await rt.shutdown();
    }
    expect(existsSync(join(dir, REPETITION_LOG_NAME)), "没塌陷就没有 JSONL").toBe(false);
    expect(existsSync(join(dir, REPETITION_COPY_DIRNAME)), "没塌陷就没有副本目录").toBe(false);
  });

  it("非 DeepSeek 模型塌陷 ⇒ 守卫不启用，同样零 sidecar（fail-closed 不被削弱）", async () => {
    const h = makeEngineHarness({ sessions: { s4: [] } });
    harnesses.push(h);
    const dir = join(h.workspace, "s4");
    // 注意：id 里**不得**出现 "deepseek" 子串 —— 守卫是子串匹配（isDeepSeekModel），
    // 用它自己的名字当反例会假绿（实测踩到）。
    const other: Profile = { ...PROFILE, model: "gpt-4o-mini" };
    const services = h.studio.services;
    const composer = new SessionComposer({
      env: {},
      baseProfile: () => other,
      llm: () => createOfflineLlm({ script: [{ text: COLLAPSE }, { text: HEALTHY }], chunkChars: 24 }),
      workers: false,
      ledgerFile: null,
      resolveSession: (id): SessionTarget | null => {
        const resolved = services.sessions.resolve(id);
        return resolved.ok ? { sessionId: id, dir: resolved.value.dir, workspace: sessionWorkspaceOf(resolved.value) } : null;
      },
    });
    const rt = composer.compose("sample-ws/s4", dir);
    try {
      await rt.runTurn("go");
    } finally {
      await rt.shutdown();
    }
    expect(existsSync(join(dir, REPETITION_LOG_NAME)), "非 DeepSeek 模型不该被定罪").toBe(false);
  });
});
