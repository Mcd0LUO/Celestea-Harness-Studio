// @vitest-environment jsdom
/**
 * A4a · composer-surface §9 的适配缝、草稿（E3 三纪律）、退役清单与 IME 回归。
 * 断言只守**后果**：草稿能回来、组合中的 Enter 不发出去、退役物真的不在了。
 * ========================================================================== */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';
import { type EditorRoot, loadComposer, mountOn } from './lib/composer-dom.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SRC = (p: string): string => readFileSync(join(REPO, p), 'utf8');

interface DraftPayload { v: number; nodes: string; text: string; state: string | null }

type Decoded = { kind: 'state'; v: number; text: string; state: string } | { kind: 'text'; text: string } | { kind: 'empty' };

interface DraftMod {
  DRAFT_VERSION: number;
  encodeDraft(text: string, state: string | null, nodes: readonly string[]): string;
  decodeDraft(raw: string | null | undefined, nodes: readonly string[]): Decoded;
  writeStoredDraft(sessionId: string, payload: string): void;
  readStoredDraft(sessionId: string): string | null;
  draftKey(sessionId: string): string;
}

const NODES = ['root', 'paragraph', 'text', 'linebreak'];

function newRoot(): EditorRoot {
  const el = doc.createElement('div');
  el.id = 'input';
  doc.body.appendChild(el);
  return el as unknown as EditorRoot;
}

beforeEach(() => {
  resetHarness();
  localStorage.clear();
  vi.resetModules();
});
afterEach(() => {
  doc.body.replaceChildren();
  localStorage.clear();
  vi.unstubAllGlobals();
});

// ───────────────── ① 草稿编解码（E3 三纪律，纯函数） ─────────────────
describe('A4a · 草稿持久化：E3 的三条纪律', () => {
  const draft = async (): Promise<DraftMod> =>
    (await import(/* @vite-ignore */ at('ui/composer/draft.ts'))) as unknown as DraftMod;

  it("纪律①：载荷带 v 版本字段，且带规范文本明文副本", async () => {
    const d = await draft();
    const payload = d.encodeDraft("你好", "STATE", NODES) as string;
    const parsed = JSON.parse(payload) as DraftPayload;
    expect(parsed.v, "v 字段必须在载荷里").toBe(d.DRAFT_VERSION);
    expect(parsed.text, "降级路径的最后兜底").toBe("你好");
  });

  it("纪律①：v 版本不匹配 ⇒ 降级纯文本（且保住字）", async () => {
    const d = await draft();
    const payload = JSON.stringify({ v: 999, nodes: "root", text: "别丢我", state: "{}" });
    expect(d.decodeDraft(payload, NODES)).toEqual({ kind: "text", text: "别丢我" });
  });

  it("纪律②：node 注册表指纹对不上 ⇒ 降级纯文本", async () => {
    const d = await draft();
    const payload = d.encodeDraft("字在", "STATE", ["root", "paragraph"]) as string;
    const out = d.decodeDraft(payload, NODES);
    expect(out.kind, "新增 node 类型后旧草稿不得按状态恢复").toBe("text");
    expect(out.kind === "text" ? out.text : "").toBe("字在");
  });

  it("纪律③：不是 JSON 的旧草稿按纯文本读出来（不是当成空草稿）", async () => {
    const d = await draft();
    expect(d.decodeDraft("裸文本草稿", NODES)).toEqual({ kind: "text", text: "裸文本草稿" });
  });

  it("纪律③：state 缺失 / 空 ⇒ 降级纯文本；空载荷 ⇒ empty", async () => {
    const d = await draft();
    const ns = JSON.stringify({ v: d.DRAFT_VERSION, nodes: NODES.join(","), text: "t", state: null });
    expect(d.decodeDraft(ns, NODES)).toEqual({ kind: "text", text: "t" });
    expect(d.decodeDraft("", NODES)).toEqual({ kind: "empty" });
    expect(d.decodeDraft(null, NODES)).toEqual({ kind: "empty" });
  });

  it("刷新恢复：写进去的载荷能读回来；空载荷 ⇒ 删键", async () => {
    const d = await draft();
    d.writeStoredDraft("s1", d.encodeDraft("草稿内容", "STATE", NODES));
    expect(d.readStoredDraft("s1")).toContain("草稿内容");
    expect(d.draftKey("s1")).not.toBe(d.draftKey("s2"));
    d.writeStoredDraft("s1", "");
    expect(d.readStoredDraft("s1"), "空载荷必须删键").toBeNull();
  });
});

// ───────────────── ② 适配缝：草稿往返 + 文本读写 ─────────────────
describe('A4a · ComposerAdapter：草稿往返与读写', () => {

  it("写入 → 取载荷 → 清空 → 恢复：字回来（返回 state 而非降级）", async () => {
    const root = newRoot();
    const h = await mountOn(root);
    const mod = await loadComposer();
    h.type("第一行\n第二行");
    const payload = mod.draftPayload();
    expect((JSON.parse(payload) as DraftPayload).text).toBe("第一行\n第二行");
    h.type("");
    const how = mod.restoreDraftPayload(payload);
    expect(how, "版本与 node 都对得上时必须照状态恢复").toBe("state");
    expect(h.text()).toBe("第一行\n第二行");
  });

  it("降级路径：state 解析失败 ⇒ 恢复纯文本，字一个不丢", async () => {
    const root = newRoot();
    const h = await mountOn(root);
    const mod = await loadComposer();
    const broken = JSON.stringify({ v: 1, nodes: NODES.join(","), text: "救我", state: "不是 JSON" });
    expect(mod.restoreDraftPayload(broken), "读不出状态必须降级").toBe("text");
    expect(h.text()).toBe("救我");
  });

  it("空载荷 ⇒ empty 且输入栏被清空", async () => {
    const root = newRoot();
    const h = await mountOn(root);
    const mod = await loadComposer();
    h.type("待清空的字");
    expect(mod.restoreDraftPayload("")).toBe("empty");
    expect(h.text()).toBe("");
  });

  it("replaceRange 只换 [start,end)：@文件补全的逐级进入依赖它", async () => {
    const root = newRoot();
    const h = await mountOn(root);
    const mod = await loadComposer();
    h.type("看 @sr 尾巴");
    mod.replaceComposerRange(2, 5, "@src/");
    expect(h.text()).toBe("看 @src/ 尾巴");
  });

  it("placeholder 走适配缝：属性与 CSS 真源是同一个字符串", async () => {
    const root = newRoot();
    await mountOn(root);
    const mod = await loadComposer();
    mod.setComposerPlaceholder("输入消息，Enter 发送");
    expect((root as unknown as { placeholder: string }).placeholder).toBe("输入消息，Enter 发送");
    expect(root.dataset.composerPlaceholder, "CSS ::before 的真源").toBe("输入消息，Enter 发送");
  });

  it("空态标记：空 → true，有字 → false", async () => {
    const root = newRoot();
    const h = await mountOn(root);
    expect(root.dataset.empty, "装配即空").toBe("true");
    h.type("字");
    expect(root.dataset.empty).toBe("false");
  });
});

// ───────────────── ③ Enter 车道 + IME（回归面） ─────────────────
describe('A4a · Enter 车道：newline.ts 的判定逐字保留在 Lexical 挂载点上', () => {

  it("桌面裸 Enter ⇒ 发送规范文本到当前车道", async () => {
    const root = newRoot();
    const sent: string[] = [];
    const h = await mountOn(root, { send: (t: string, l: string) => sent.push(t + "|" + l) });
    h.type("普通一句话");
    const e = h.press({ key: "Enter" });
    expect(sent).toEqual(["普通一句话|steer"]);
    expect((e as { defaultPrevented: boolean }).defaultPrevented, "发送必须吃掉默认动作").toBe(true);
  });

  it("桌面 Ctrl+Enter ⇒ 另一条车道", async () => {
    const root = newRoot();
    const sent: string[] = [];
    const h = await mountOn(root, { send: (t: string, l: string) => sent.push(t + "|" + l) });
    h.type("q");
    h.press({ key: "Enter", ctrlKey: true });
    expect(sent).toEqual(["q|queue"]);
  });

  it("桌面 Shift+Enter ⇒ 不发送（交回编辑器插换行）", async () => {
    const root = newRoot();
    const sent: string[] = [];
    const h = await mountOn(root, { send: (t: string) => sent.push(t) });
    h.type("a");
    const e = h.press({ key: "Enter", shiftKey: true });
    expect(sent).toEqual([]);
    expect((e as { defaultPrevented: boolean }).defaultPrevented).toBe(false);
  });

  it("★ 桌面 IME 组合中的 Enter 不发送、内容保留、默认动作被吃掉（W2032）", async () => {
    const root = newRoot();
    const sent: string[] = [];
    const h = await mountOn(root, { send: (t: string) => sent.push(t) });
    h.type("nihaoni hao");
    const e = h.press({ key: "Enter", isComposing: true });
    expect(sent, "★ 组合中不得发送").toEqual([]);
    expect(h.text(), "★ 组合文字必须留在输入栏里").toBe("nihaoni hao");
    expect((e as { defaultPrevented: boolean }).defaultPrevented).toBe(true);
  });

  it("★ keyCode=229（isComposing 已复位）同样不发送 —— 判据两半都在（W2033）", async () => {
    const root = newRoot();
    const sent: string[] = [];
    const h = await mountOn(root, { send: (t: string) => sent.push(t) });
    h.type("にほんご");
    const e = h.press({ key: "Enter", isComposing: false, keyCode: 229 });
    expect(sent).toEqual([]);
    expect(h.text()).toBe("にほんご");
    expect((e as { defaultPrevented: boolean }).defaultPrevented).toBe(true);
  });

  it("触摸端裸 Enter ⇒ 换行、不发送（W2028 语义不变）", async () => {
    const root = newRoot();
    const sent: string[] = [];
    const h = await mountOn(root, { send: (t: string) => sent.push(t), isTouch: () => true });
    h.type("触");
    h.press({ key: "Enter" });
    expect(sent).toEqual([]);
    expect(h.text(), "换行必须真的发生").toBe("触\n");
  });

  it("★ 触摸端组合中的 Enter 仍是 native：不发送、不吞默认动作", async () => {
    const root = newRoot();
    const sent: string[] = [];
    const h = await mountOn(root, { send: (t: string) => sent.push(t), isTouch: () => true });
    h.type("ni");
    const e = h.press({ key: "Enter", isComposing: true });
    expect(sent).toEqual([]);
    expect((e as { defaultPrevented: boolean }).defaultPrevented).toBe(false);
  });

  it("补全框的键盘总拦截口先于 Enter 判定", async () => {
    const root = newRoot();
    const sent: string[] = [];
    const h = await mountOn(root, { send: (t: string) => sent.push(t) });
    h.type("/");
    const mod = await loadComposer();
    let seen = 0;
    mod.setComposerKeyInterceptor(() => { seen += 1; return true; });
    h.press({ key: "Enter" });
    expect(seen, "拦截口必须真的被调用").toBe(1);
    expect(sent, "被补全框消费的那次 Enter 不得发出去").toEqual([]);
  });
});

// ───────────────── ④ 粘贴（附件三入口之一） ─────────────────
describe('A4a · 粘贴：强制纯文本 + 文件转附件车道', () => {

  it("粘贴里的文件走附件车道，纯文本仍进编辑器", async () => {
    const root = newRoot();
    const files: File[] = [];
    const h = await mountOn(root, { onFiles: (fs: File[]) => files.push(...fs) });
    h.type("前缀");
    const f = new File(["x"], "a.txt", { type: "text/plain" });
    // jsdom 没有 DataTransfer / ClipboardEvent 构造器，这里手搓一个形状相同的载荷：
    // 被测的是**适配缝怎么用剪贴板**（items → 文件、text/plain → 正文），不是浏览器。
    const dt = {
      items: [{ kind: "file", type: "text/plain", getAsFile: () => f }],
      files: [f],
      getData: () => "尾巴",
    };
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: dt });
    root.dispatchEvent(ev);
    expect(files.map((x) => x.name), "附件车道必须收到文件").toEqual(["a.txt"]);
    expect(h.text(), "同一次粘贴里的文字照常进编辑器").toContain("尾巴");
  });
});

// ───────────────── ⑤ 退役清单（结构断言） ─────────────────
describe('A4a · §9.3 退役清单：退役物不得复活', () => {

  const RETIRED = [
    "apps/web/src/ui/inputbar/caret-mirror.ts",
    "apps/web/src/ui/inputbar/grow.ts",
    "apps/web/src/styles/caret.css",
    "apps/web/src/styles/field-sizing.css",
  ];
  // 只认**代码里的引用**（import / 调用），不认注释：注释里保留退役史是刻意的（AGENTS.md
  // 「W 号是活引用索引」），把注释也扫进来会让这条门禁在正确维护注释时变红。
  const NEEDLES = [
    "./inputbar/caret-mirror",
    "styles/caret.css",
    "./inputbar/grow",
    "styles/field-sizing.css",
    "createAutoGrow(",
    "bindEnterKey(",
    "mountCaretMirror(",
  ];

  it("退役物不再存在于工作树", () => {
    for (const p of RETIRED) expect(existsSync(join(REPO, p)), p + " 必须已退役").toBe(false);
  });

  it("apps/web 里没有任何地方再引用它们", () => {
    const hits: string[] = [];
    const code = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "dist" && e.name !== "node_modules") walk(p);
          continue;
        }
        if (!/\.(ts|css|html)$/.test(e.name)) continue;
        const text = code(readFileSync(p, "utf8"));
        for (const needle of NEEDLES) {
          if (text.includes(needle)) hits.push(p + " -> " + needle);
        }
      }
    };
    walk(join(REPO, "apps", "web"));
    expect(hits, "退役物不得被任何源码再引用（注释里的退役史不算）").toEqual([]);
  });

  it("#input 已不是 textarea（E4 直接替换，不留双实现）", () => {
    const html = SRC("apps/web/index.html");
    expect(html, "#input 必须是 div（Lexical editor root）").toMatch(/<div id="input"/);
    expect(html, "不得再有 textarea 版的 #input").not.toMatch(/<textarea id="input"/);
    expect(html, "可访问名仍在（aria-label）").toMatch(/id="input"[^>]*data-i18n-aria-label="chat\.input\.ariaLabel"/);
  });

  it("textarea 的 placeholder 渲染体系已退役", () => {
    const css = SRC("apps/web/src/styles/composer.css");
    expect(css, "占位符走 data-empty + ::before").toMatch(/#input\[data-empty=.true.\]::before/);
    expect(css, "不得再用原生 ::placeholder 体系").not.toMatch(/::placeholder/);
    expect(SRC("apps/web/src/styles/layout.css"), "#input 不得再有 field-sizing").not.toMatch(/field-sizing/);
  });

  it("自增高只剩 max-height + overflow-y，且上限仍是退役前的 240px", () => {
    const css = SRC("apps/web/src/styles/composer.css");
    expect(css).toMatch(/max-height:\s*240px/);
    expect(css).toMatch(/overflow-y:\s*auto/);
  });

  it("模块体积：新模块都在默认上限 450 行之内", () => {
    for (const f of ["adapter.ts", "draft.ts", "lexical.ts", "index.ts"]) {
      const p = join(REPO, "apps", "web", "src", "ui", "composer", f);
      const lines = readFileSync(p, "utf8").split("\n").length;
      expect(lines, p + " 超过默认上限").toBeLessThanOrEqual(450);
    }
  });
});