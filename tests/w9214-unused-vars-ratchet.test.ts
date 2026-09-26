// @vitest-environment node
/**
 * W9214 —— 未使用绑定棘轮（`eslint.config.js`）的机械证明。
 *
 * 为什么需要这个文件：本轮新增的规则是**门禁本身**。门禁的红/绿不能靠人眼读
 * 一次输出，必须有用例钉住三个方向：
 *   ① 新违规必须**变红**（否则等于没有门禁）；
 *   ② 已冻结的老违规必须**保持绿**（否则本轮会留一堆红给别人）；
 *   ③ 冻结表**只许收紧**：名字被清理后必须提醒（默认 warn，ARCH_STRICT=1 时红），
 *      且**调包**（删一个冻结名、加一个全新名、条数不变）必须被抓住。
 *
 * ③ 是本文件存在的核心理由：W9214 实测发现 ESLint **内建 suppressions 按条数记账**，
 * 在冻结文件里做「调包」条数不变、`npx eslint .` 仍然 EXIT=0 —— 那种棘轮等于没有。
 * 本实现按**标识符名**记账，调包必红。
 *
 * 口径：用 ESLint 的 Node API 对**虚拟路径**跑 lintText（不落盘、不碰真实文件），
 * 但**加载的是仓根真实 eslint.config.js** —— 测的就是那条真规则。
 */
import { ESLint, type Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

type Message = Linter.LintMessage;

const eslint = new ESLint();

/** 对一段虚拟源码按给定的仓库相对路径跑真实配置，返回相关消息。 */
async function lintAs(filePath: string, code: string): Promise<Message[]> {
  const [result] = await eslint.lintText(code, { filePath });
  if (result === undefined) throw new Error('lintText returned no result for ' + filePath);
  return result.messages.filter(
    (m: Message) => m.ruleId === 'arch/unused-vars' || m.ruleId === 'arch/unused-vars-stale',
  );
}

const errorsOf = (messages: Message[]): Message[] => messages.filter((m) => m.severity === 2);
const staleWarnings = (messages: Message[]): Message[] =>
  messages.filter((m) => m.ruleId === 'arch/unused-vars-stale');

describe('W9214 未使用绑定棘轮', () => {
  it('全新未使用的导入 ⇒ 报 error（门禁真的拦得住新违规）', async () => {
    const messages = await lintAs('scripts/__w9214_probe__.ts', 'import { rmSync } from "node:fs";\n');
    expect(errorsOf(messages).map((m) => m.message)).toEqual([
      expect.stringContaining("'rmSync' is defined but never used"),
    ]);
  });

  it('全新未使用的变量 ⇒ 报 error', async () => {
    const messages = await lintAs('packages/core/src/__w9214_probe__.ts', 'const zzzUnused = 1;\n');
    expect(errorsOf(messages)).toHaveLength(1);
    expect(errorsOf(messages)[0]?.message).toContain("'zzzUnused'");
  });

  it('冻结表里的名字 ⇒ 不报（老违规保持绿）', async () => {
    // w9204-rail-layout.test.ts 冻结了 "msgs"。
    const messages = await lintAs('tests/w9204-rail-layout.test.ts', 'const msgs = 1;\n');
    expect(errorsOf(messages)).toEqual([]);
  });

  it('★ 调包（删冻结名 + 加全新名，条数不变）⇒ 新名必须报 error', async () => {
    // 这正是 ESLint 内建 suppressions 会静默吞掉的形状：条数仍为 1。
    const messages = await lintAs('tests/w9204-rail-layout.test.ts', 'const zzzBrandNew = 1;\n');
    expect(errorsOf(messages).map((m) => m.message)).toEqual([
      expect.stringContaining("'zzzBrandNew'"),
    ]);
    // 同时提醒冻结的 msgs 已陈旧（被替换掉了）。
    expect(staleWarnings(messages).map((m) => m.message).join(' ')).toContain("'msgs'");
  });

  it('冻结名被清理干净 ⇒ 提醒收紧（默认 warn，不是 error）', async () => {
    // 刻意用**没有**任何未使用绑定的源码：文件已清干净，冻结名 KEY 因此陈旧。
    // （第一版这里写了 `const unrelated = 1`，那本身就是一条新违规 —— 门禁正确地把它
    //  报成了 error，是本用例写错了，不是机制错了。）
    const messages = await lintAs('tests/w895l-plugin-library.test.ts', 'export const used = 1;\n');
    const stale = staleWarnings(messages);
    expect(stale.map((m) => m.message).join(' ')).toContain("'KEY'");
    expect(errorsOf(messages), '陈旧项默认不得让门禁变红（多 worker 共用一个工作树）').toEqual([]);
  });

  it('冻结表只覆盖 tests/：产品源码不留任何冻结项', async () => {
    // 反向锁死本轮的清理承诺：packages/ / apps/studio/src / apps/cli/src / scripts 里
    // 任何一个未使用绑定都必须报 error（即这些目录已零冻结）。
    const probes: [string, string][] = [
      ['packages/core/src/__w9214_probe__.ts', 'const zzzA = 1;\n'],
      ['apps/studio/src/__w9214_probe__.ts', 'const zzzB = 1;\n'],
      ['apps/cli/src/__w9214_probe__.ts', 'const zzzC = 1;\n'],
      ['scripts/__w9214_probe__.ts', 'const zzzD = 1;\n'],
    ];
    for (const [filePath, code] of probes) {
      expect(errorsOf(await lintAs(filePath, code)), filePath + ' 必须零冻结').toHaveLength(1);
    }
  });

  it('规则参数按实测口径生效：args none / ^_ / caughtErrors / rest siblings 都不报', async () => {
    const code = [
      'const _intentional = 1;',                    // varsIgnorePattern ^_
      'export function f(a: number): number { return 1; }', // args: "none"
      'export function g(): void { try { throw new Error("x"); } catch (err) { /* 刻意不读 */ } }',
      'const o = { a: 1, b: 2 };',
      'const { a, ...rest } = o;',                  // ignoreRestSiblings
      'export const keep = rest;',
      '',
    ].join('\n');
    const messages = await lintAs('packages/core/src/__w9214_probe__.ts', code);
    expect(errorsOf(messages)).toEqual([]);
  });
});
