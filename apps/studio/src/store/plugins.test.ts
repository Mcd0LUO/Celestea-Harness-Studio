/**
 * W9322 — 插件停用表的**纯 store**（`store/plugins.ts`）。
 * W9331 — 外加「显式启用表」（`enabled`）与 v1 向后兼容。
 *
 * 与 `store/display-plugins.test.ts` 同形，因为两者的语义是同一套：存的是
 * **disabled** 集合（新插件默认开）；文件不存在 = 空表且无 warning；
 * 损坏/陌生的文件 = 「什么都没被停用」+ 一条 warning —— 绝不「修复」。
 *
 * W9331 起的唯一扩展：另存一个 `enabled` 集合，表示「对**默认关**的插件的显式
 * 打开」。两个集合都空 = 目录默认值生效，这正是损坏文件的降级方向。
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
    expect(readPlugins(tempDir())).toEqual({ disabled: [], enabled: [], warnings: [] });
  });

  it("round-trips a normalized disabled list through the atomic write", () => {
    const dir = tempDir();
    const saved = writePlugins(dir, [" studio.engine.tools ", "studio.engine.tools", "", "celestea.runtime.swarm"], 1_700_000_000);
    expect(saved).toEqual(["studio.engine.tools", "celestea.runtime.swarm"]);
    expect(readPlugins(dir)).toEqual({ disabled: ["studio.engine.tools", "celestea.runtime.swarm"], enabled: [], warnings: [] });
    // The file is hand-inspectable and carries the version + stamp. W9331 bumped
    // the written version to 2 (the `enabled` table); v1 is still READ, below.
    const raw = JSON.parse(readFileSync(join(dir, PLUGINS_FILE), "utf8")) as Record<string, unknown>;
    expect(raw["version"]).toBe(2);
    expect(raw["updated_at"]).toBe(1_700_000_000);
    expect(raw["enabled"]).toEqual([]);
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

  it("broken JSON / wrong shape / wrong version / empty file degrade to the DEFAULTS with ONE warning", () => {
    const cases = ['{ not json', '"x"', '["a",3,null,"b"]', '{"version":9,"disabled":["a"]}', '{}', ''];
    for (const body of cases) {
      const dir = tempDir();
      writeRaw(dir, body);
      const read = readPlugins(dir);
      expect(read.disabled, body).toEqual([]);
      expect(read.enabled, body).toEqual([]);
      expect(read.warnings, body).toHaveLength(1);
      // W9331 wording: the file is not repaired, and both tables read empty — which
      // means "no user intent", i.e. the CATALOG defaults apply. The old string said
      // "every plugin is enabled", which stopped being true the moment one row
      // defaulted to off.
      expect(read.warnings[0], body).toContain("every default-enabled plugin is enabled");
    }
  });
});

describe("W9331 plugins store · the explicit-enable table and v1 back-compat", () => {
  it("round-trips BOTH tables, in order, through the atomic write", () => {
    const dir = tempDir();
    writePlugins(dir, ["studio.engine.tools"], 1_700_000_000, [" celestea.runtime.swarm ", "celestea.runtime.swarm", ""]);
    expect(readPlugins(dir)).toEqual({ disabled: ["studio.engine.tools"], enabled: ["celestea.runtime.swarm"], warnings: [] });
  });

  it("reads a LEGACY v1 file byte-for-byte as before: enabled is absent, not invented", () => {
    // The exact shape every deployment written before W9331 has on disk. It must
    // stay readable with NO migration step and NO lost data.
    const dir = tempDir();
    writeRaw(dir, JSON.stringify({ version: 1, disabled: ["studio.engine.tools"], updated_at: 1_700_000_000 }));
    expect(readPlugins(dir)).toEqual({ disabled: ["studio.engine.tools"], enabled: [], warnings: [] });
  });

  it("reads a v1 file with no `disabled` key the same way it always did (degrade + warn)", () => {
    const dir = tempDir();
    writeRaw(dir, JSON.stringify({ version: 1, updated_at: 1 }));
    const read = readPlugins(dir);
    expect(read.disabled).toEqual([]);
    expect(read.enabled).toEqual([]);
    expect(read.warnings[0]).toContain("no `disabled` array of strings");
  });

  it("a v2 file missing `enabled` keeps the disabled table and says so (partial, not voided)", () => {
    // Voiding BOTH tables here would be the dangerous direction: a hand-edited file
    // that lost one key would silently re-enable everything the user had turned off.
    const dir = tempDir();
    writeRaw(dir, JSON.stringify({ version: 2, disabled: ["studio.engine.tools"] }));
    const read = readPlugins(dir);
    expect(read.disabled).toEqual(["studio.engine.tools"]);
    expect(read.enabled).toEqual([]);
    expect(read.warnings[0]).toContain("declares version 2 but has no `enabled` array");
  });

  it("keeps an `enabled` name the catalog does not know (same posture as `disabled`)", () => {
    const dir = tempDir();
    writePlugins(dir, [], 1_700_000_000, ["ghost/plugin"]);
    expect(readPlugins(dir).enabled).toEqual(["ghost/plugin"]);
  });
});
