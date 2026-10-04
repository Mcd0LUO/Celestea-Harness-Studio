/**
 * W9322 — 插件停用表的**纯 store**（`store/plugins.ts`）。
 *
 * 与 `store/display-plugins.test.ts` 同形，因为两者的语义是同一套：存的是
 * **disabled** 集合（新插件默认开）；文件不存在 = 空表且无 warning；
 * 损坏/陌生的文件 = 「什么都没被停用」+ 一条 warning —— 绝不「修复」。
 *
 * 与 display-plugins 的一处**有意差别**也在这里钉住：这个 store **不做**
 * 「名字是否在清单里」的校验（那是 `plugin-hotswap.ts` 用 catalog 做的），
 * 所以它对 id 仍然是「照单全收的字符串表」——这样 store 保持纯数据层，
 * 策略只有一处。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_DISABLED_PLUGINS, PLUGINS_FILE, normalizeDisabledPlugins, readPlugins, writePlugins } from "./plugins.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "w9322-plugins-"));
  dirs.push(dir);
  return dir;
}

function writeRaw(dir: string, body: string): void {
  writeFileSync(join(dir, PLUGINS_FILE), body, "utf8");
}

describe("W9322 plugins store", () => {
  it("a missing file reads as the empty table, with no warning", () => {
    expect(readPlugins(tempDir())).toEqual({ disabled: [], warnings: [] });
  });

  it("round-trips a normalized disabled list through the atomic write", () => {
    const dir = tempDir();
    const saved = writePlugins(dir, [" studio.engine.tools ", "studio.engine.tools", "", "celestea.runtime.swarm"], 1_700_000_000);
    expect(saved).toEqual(["studio.engine.tools", "celestea.runtime.swarm"]);
    expect(readPlugins(dir)).toEqual({ disabled: ["studio.engine.tools", "celestea.runtime.swarm"], warnings: [] });
    // The file is hand-inspectable and carries the version + stamp.
    const raw = JSON.parse(readFileSync(join(dir, PLUGINS_FILE), "utf8")) as Record<string, unknown>;
    expect(raw["version"]).toBe(1);
    expect(raw["updated_at"]).toBe(1_700_000_000);
  });

  it("keeps a name the catalog does not know (that filter is the policy layer's job)", () => {
    const dir = tempDir();
    writePlugins(dir, ["ghost/plugin"], 1_700_000_000);
    expect(readPlugins(dir).disabled).toEqual(["ghost/plugin"]);
  });

  it("normalize trims, drops blanks, dedupes keeping first-occurrence order, and caps the list", () => {
    expect(normalizeDisabledPlugins([" a ", "b", "a", "", "  "])).toEqual(["a", "b"]);
    const long = Array.from({ length: MAX_DISABLED_PLUGINS + 10 }, (_v, i) => `p${i}`);
    expect(normalizeDisabledPlugins(long)).toHaveLength(MAX_DISABLED_PLUGINS);
  });

  it("broken JSON / wrong shape / wrong version / empty file degrade to all-ON with ONE warning", () => {
    const cases = ['{ not json', '"x"', '["a",3,null,"b"]', '{"version":2,"disabled":["a"]}', '{}', ''];
    for (const body of cases) {
      const dir = tempDir();
      writeRaw(dir, body);
      const read = readPlugins(dir);
      expect(read.disabled, body).toEqual([]);
      expect(read.warnings, body).toHaveLength(1);
      expect(read.warnings[0], body).toContain("every plugin is enabled");
    }
  });
});
