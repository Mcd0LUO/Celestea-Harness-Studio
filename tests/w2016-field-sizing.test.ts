// @vitest-environment jsdom
/**
 * W2016 · 输入框自增长「能力交给 CSS + JS 回落」守护。
 *
 * 用户原话：「用 field-sizing: content 删掉输入框自增长的 JS 量高」。
 * W2008 实测确认：`field-sizing: content` 能让 textarea 自己长高，Chrome/Edge 123+
 * 支持；**Firefox 155 / WebKit 26.6 不支持**（静默忽略）。
 *
 * 本文件钉四条**机械**不变量（真机几何/数字见 results/W2016-field-sizing.md）：
 *   ① 样式侧的 `field-sizing: content` **必须**包在 `@supports (field-sizing: content)`
 *      里，且同一条规则里必须有 `max-height`（= 长到上限就滚动，与 JS 口径一致）；
 *   ② `#input` 上不得出现**无条件**的 field-sizing 声明（那等于把回落删了）；
 *   ③ JS 侧的判定必须来自 `CSS.supports('field-sizing','content')`，且**不支持时必须
 *      仍然绑定量高实现**（把这条改坏 ⇒ 真机上 FF/WebKit 的输入框不再自增长）；
 *   ④ 探针自身 fail-closed：没有 CSS.supports / 抛异常 ⇒ 判「不支持」（绑定回落），
 *      绝不能判「支持」（那才会丢字）。
 *
 * ★ 为什么 ③④ 必须用**注入的 supports** 测：jsdom 的 `CSS.supports` 对任何特性都
 *   返回 true（实测 field-sizing / interpolate-size 都是 true），在 jsdom 里断言
 *   「探测结果」是**空转**的 —— 把探测写成可注入的纯函数才能把两条分支都钉死。
 *   真机分支证据（三引擎 clientHeight 曲线 + 截图）在报告里。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web');
const at = (rel: string): string => pathToFileURL(join(WEB, 'src', rel)).href;
const read = (rel: string): string => readFileSync(join(WEB, rel), 'utf8');
/** 注释里会**引用**被禁的写法做说明（grow.ts 头注就点名了 `style.height='auto'`），
 *  所以判「有没有那段代码」之前先剥注释 —— 否则「写清楚为什么」反而把门禁搞红。 */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const CSS_FILE = 'src/styles/field-sizing.css';
/** 承载输入框样式的既有真源：无条件写 field-sizing 就是「把回落删了」。 */
const GUARDED = ['src/styles/layout.css', 'src/styles/responsive.css', 'src/styles/field-sizing.css'];

describe('W2016 ① 样式侧：field-sizing 必须被 @supports 守卫', () => {
  it('声明在 @supports (field-sizing: content) 块内，且同块有 max-height', () => {
    const text = read(CSS_FILE);
    const block = /@supports\s*\(\s*field-sizing\s*:\s*content\s*\)\s*\{([\s\S]*?)\n\}/.exec(text);
    expect(block, '必须有 @supports (field-sizing: content) 块').not.toBeNull();
    const inner = block![1] ?? '';
    expect(inner, '守卫块内必须有 field-sizing: content').toMatch(/field-sizing:\s*content/);
    expect(inner, '守卫块内必须有 max-height（长到上限就滚动）').toMatch(/max-height:\s*\d+px/);
  });

  it('★ 绝不无条件声明 field-sizing（那等于把 FF/WebKit 的回落删掉）', () => {
    for (const f of GUARDED) {
      const text = read(f);
      const outside = text.replace(/@supports[^{]*\{[\s\S]*?\n\}/g, '');
      expect(
        /field-sizing\s*:/.test(code(outside)),
        f + ' 在 @supports 之外声明了 field-sizing',
      ).toBe(false);
    }
  });

  it('max-height 与 JS 回落的 240px 同口径（不是 layout.css 的 336px 令牌）', () => {
    const block = /@supports\s*\(\s*field-sizing\s*:\s*content\s*\)\s*\{([\s\S]*?)\n\}/.exec(read(CSS_FILE))![1] ?? '';
    const m = /max-height:\s*(\d+)px/.exec(block);
    expect(Number(m![1]), '与 grow.ts 的 MAX_HEIGHT 必须逐字相同').toBe(240);
    expect(read('src/ui/inputbar/grow.ts')).toMatch(/MAX_HEIGHT\s*=\s*240/);
  });

  it('样式已接线（main.ts 有 import —— 不接线 = 全引擎都走回落）', () => {
    expect(read('src/main.ts')).toContain("import './styles/field-sizing.css'");
  });
});

describe('W2016 ② 生产文件里不再有第二份量高实现', () => {
  it('inputbar.ts / viewctx.ts 不再自己量 #input 的高', () => {
    for (const rel of ['src/ui/inputbar.ts', 'src/ui/viewctx.ts']) {
      const src = code(read(rel));
      expect(src.includes('input.style.height'), rel + ' 不得再直接写输入框高度').toBe(false);
      expect(src.includes('input.scrollHeight'), rel + ' 不得再读输入框 scrollHeight').toBe(false);
    }
  });

  it('量高实现只剩 grow.ts 一处（回落分支）', () => {
    const src = code(read('src/ui/inputbar/grow.ts'));
    expect(src, '回落分支仍是原来的量高实现').toMatch(/style\.height\s*=\s*'auto'/);
    expect(src).toMatch(/Math\.min\(input\.scrollHeight,\s*o\.maxHeight\)/);
    // 判定必须来自 CSS.supports('field-sizing','content')
    expect(src).toMatch(/CSS\.supports\('field-sizing',\s*'content'\)/);
  });
});

describe('W2016 ③ 能力开关：支持时 no-op，不支持时量高（注入式，两条分支都钉）', () => {
  const mod = async (): Promise<{
    createAutoGrow(input: unknown, o: { maxHeight: number; supports?: () => boolean }): () => void;
    supportsFieldSizing(): boolean;
    MAX_HEIGHT: number;
  }> => (await import(/* @vite-ignore */ at('ui/inputbar/grow.ts'))) as never;

  interface ElLike {
    style: Record<string, unknown>;
    scrollHeight: number;
  }
  const el = (scrollHeight: number): ElLike => ({ style: {}, scrollHeight });

  it('支持 field-sizing ⇒ 拿到 no-op：不写 style.height、不读 scrollHeight', async () => {
    const g = await mod();
    const input = el(1000);
    let reads = 0;
    Object.defineProperty(input, 'scrollHeight', { get: () => { reads += 1; return 1000; } });
    const grow = g.createAutoGrow(input, { maxHeight: 240, supports: () => true });
    grow();
    grow();
    expect(input.style['height'], 'no-op 不得写 style.height').toBeUndefined();
    expect(reads, 'no-op 不得读 scrollHeight（= 省掉强制同步布局）').toBe(0);
  });

  it('★ 不支持 ⇒ 仍然量高，且封顶 maxHeight（FF/WebKit 的回落）', async () => {
    const g = await mod();
    const tall = el(1000);
    g.createAutoGrow(tall, { maxHeight: 240, supports: () => false })();
    expect(tall.style['height'], '超过上限 ⇒ 封顶（出现内部滚动）').toBe('240px');
    const short = el(60);
    g.createAutoGrow(short, { maxHeight: 240, supports: () => false })();
    expect(short.style['height'], '未超上限 ⇒ 按内容高').toBe('60px');
  });

  it('探针 fail-closed：没有 CSS / CSS.supports 抛异常 ⇒ 判「不支持」', async () => {
    const g = await mod();
    const real = (globalThis as unknown as { CSS?: unknown }).CSS;
    try {
      vi.stubGlobal('CSS', undefined);
      expect(g.supportsFieldSizing(), '没有 CSS.supports ⇒ 必须判不支持（绑定回落）').toBe(false);
      vi.stubGlobal('CSS', { supports: () => { throw new Error('boom'); } });
      expect(g.supportsFieldSizing(), '探针抛异常 ⇒ 必须判不支持').toBe(false);
      vi.stubGlobal('CSS', { supports: (p: string) => p === 'field-sizing' });
      expect(g.supportsFieldSizing(), '正常路径：转发给 CSS.supports').toBe(true);
    } finally {
      vi.stubGlobal('CSS', real);
    }
  });
});

describe('W2016 ④ 装配：inputbar 的量高回调真的来自能力开关', () => {
  it('initInputBar 用 createAutoGrow 装配（不是自己再写一遍量高）', () => {
    const src = code(read('src/ui/inputbar.ts'));
    expect(src).toMatch(/autoGrow = createAutoGrow\(input,/);
    // 输入事件绑定的是回调本身（闭包），保证「装配后的实现」被调用
    expect(src).toMatch(/addEventListener\('input',\s*\(\) => autoGrow\(\)\)/);
    // 程序化改值路径也走同一个回调（否则支持与否会有第二条分叉）
    expect((src.match(/autoGrow\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
