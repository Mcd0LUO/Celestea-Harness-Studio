// @vitest-environment node
/**
 * W2007 · z-index 层级门禁（本仓第一份层级规范）。
 *
 * 为什么需要它 —— 这个 bug 能溜进来的**机制**：
 *   全仓 28 处 z-index **全是裸魔数**，没有任何规范文档、没有一处命名 token、
 *   也没有任何测试断言过任意两层的大小关系。于是「设置页(50) 低于移动端抽屉(61)」
 *   这件事**没有任何机械约束**：它既不是某次提交改坏的（两边都各自"对"），
 *   也不是某个测试该抓没抓的 —— 而是**从没有人写下过"谁该在谁上面"**。
 *   改样式的人只要不打开 390px 视口、不恰好先展开抽屉再点设置，就永远看不到。
 *   用户的报障路径（展开 → 点设置）恰恰是**唯一**暴露它的路径。
 *
 * 本门禁守三条，都是机械可判的：
 *   ① 层级令牌存在且**严格有序**（--z-scrim < --z-drawer < --z-settings < --z-modal）；
 *   ② 关键选择器**必须**引用令牌（不许退回裸魔数）——这是防"顺手改回 50"的牙；
 *   ③ 裸魔数**只减不增**：现存 24 处登记在 LEGACY_MAGIC 里（棘轮），
 *      任何**新增**裸魔数立刻红。已登记的项被改成 token ⇒ 必须从表里删掉（防陈旧）。
 *
 * 与 W847 W8（圆角/虚线门禁）同一口径：取值从 CSS **解析**出来算，不把期望值抄一遍
 * （抄一遍就变成自证：CSS 改了、测试里的字面量没改，两边一起错还全绿）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const STYLES = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web", "src", "styles");

/** 去掉注释：注释里出现的 "z-index: 50" 不是声明，不该被扫进来。 */
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");

const cssFiles = (): { name: string; raw: string; css: string }[] =>
  readdirSync(STYLES)
    .filter((f) => f.endsWith(".css"))
    .sort()
    .map((f) => {
      const raw = readFileSync(join(STYLES, f), "utf8");
      return { name: f, raw, css: strip(raw) };
    });

/** tokens.css 里 --z-* 的取值（数字字面量）。 */
function tokenScale(): Map<string, number> {
  const css = strip(readFileSync(join(STYLES, "tokens.css"), "utf8"));
  const out = new Map<string, number>();
  for (const m of css.matchAll(/(--z-[a-z-]+)\s*:\s*(\d+)\s*;/g)) out.set(m[1]!, Number(m[2]));
  return out;
}

/**
 * 全仓 z-index 声明清单。返回 {file, line, value}：
 *   · value 是数字字面量 ⇒ 裸魔数；
 *   · value 是 var(--z-*) ⇒ 已收敛。
 * 行号按**原始文件**算（报告里要能直接跳过去）。
 */
interface Decl { file: string; line: number; value: string }
function decls(): Decl[] {
  const out: Decl[] = [];
  for (const f of cssFiles()) {
    for (const m of f.css.matchAll(/z-index\s*:\s*([^;}]+)/g)) {
      const value = m[1]!.trim();
      const line = f.css.slice(0, m.index).split("\n").length;
      out.push({ file: f.name, line, value });
    }
  }
  return out;
}

/**
 * 允许存在的裸魔数（棘轮：**只许删，不许加**）。
 * 每条都写明「为什么本轮没收敛它」——不许写"遗留"了事。
 * 新增裸魔数 ⇒ 本门禁红；把已登记的项收敛成 token ⇒ 必须同时删掉这里的条目
 * （否则"陈旧项"断言会红，防止表越积越假）。
 */
const LEGACY_MAGIC: { file: string; value: number; sel: string; why: string }[] = [
  { file: "attachments.css", value: 4000, sel: ".attach-lightbox", why: "图片放大灯箱。语义上是模态层，但值 4000 已长期盖过一切；收敛会改变它与 .ctx-scrim(90) 的相对序，本轮不动。" },
  { file: "caret.css", value: 0, sel: ".caret-mirror", why: "假光标镜像：层叠上下文**内部**的绘制序，从不与浮层比大小。" },
  { file: "commands.css", value: 40, sel: ".cmd-popup", why: "斜杠命令补全框：锚在输入框上沿的浮层，理想是 --z-float(20)。收敛会把它降到 .preview-host(35) 之下，而两者可能同屏，无法用本次路径证明无回归。" },
  { file: "commands.css", value: 25, sel: ".goal-bar", why: "目标条：常驻条，理想是 --z-dock(10)；同上，本轮不挪实际位置。" },
  { file: "components.css", value: 1, sel: ".rendered .csv-table thead th", why: "sticky 表头：表格滚动容器内部的绘制序，从不与浮层比大小。" },
  { file: "components.css", value: 60, sel: ".img-zoom", why: "图片灯箱：inset:0 铺满视口且盖住侧栏设置入口 ⇒ 与设置页不可能同时可操作（真机确认），改值不可观测。" },
  { file: "components.css", value: 50, sel: ".modal", why: "**已无调用点**（弹窗统一走 sessions.css 的 .modal-scrim）。改一条不可达规则的值，无法用任何真机路径证明无回归。" },
  { file: "components.css", value: 95, sel: ".switch-progress", why: "会话切换顶部细条：非交互（pointer-events:none），盖住谁都不影响可点性。理想是 --z-progress；本轮不挪。" },
  { file: "contextview.css", value: 90, sel: ".ctx-scrim", why: "完整上下文浮层（.modal-scrim 的变体，更高一档）。理想与 --z-modal 同层，但它是「从状态栏开」的全屏只读层，收敛需另一次真机验证。" },
  { file: "hint.css", value: 60, sel: ".hint-card", why: "悬停提示卡。★ 实测它低于移动端抽屉(61) ⇒ 悬停抽屉里的会话行时提示被整个盖住（同族 bug，见报告）。但 hint.css 不在本工号的文件边界内（不可改），故只登记不改。" },
  { file: "layout.css", value: 5, sel: ".sidebar-resizer", why: "侧栏拖宽条：移动端该条 display:none，桌面端不参与浮层之争。" },
  { file: "preview.css", value: 35, sel: ".preview-host", why: "文件预览宿主：贴边常驻且 pointer-events:none，理想是 --z-dock(10)；降低会改变它与 .wb-menu(60) 的既有关系。" },
  { file: "quote.css", value: 30, sel: ".quote-float", why: "选区浮标：锚在选区旁的临时浮层，理想是 --z-float(20)。" },
  { file: "rail.css", value: 20, sel: ".railv3", why: "灵动条轨道：贴边常驻，理想是 --z-dock(10)。" },
  { file: "rail.css", value: 40, sel: ".railv3-card", why: "rail 悬停预览卡：与 .hint-card 同宿主同性质，两者相对序被 tests/w866 钉住（.ws-strip 必须在两者之间）。" },
  { file: "sessions.css", value: 60, sel: ".sess-menu", why: "会话 ⋯ 菜单：本轮**刻意保持 60**——设置页提到 70 后它已恒低于设置页，即使将来漏调 closeCtxMenu() 也压不过（不变量由层级守，不靠调用方自觉）。" },
  { file: "statusline.css", value: 40, sel: ".sl-popup", why: "状态栏下拉：锚在状态栏上的浮层，理想是 --z-float(20)。" },
  { file: "taskpanel.css", value: 3, sel: ".tp-panel", why: "任务面板：消息流内部的局部层叠，从不与浮层同屏。" },
  { file: "views.css", value: 1, sel: ".chatcol-resizer", why: "聊天列拖条：只在主区内部生效，不参与全站浮层之争。" },
  { file: "workbench.css", value: 60, sel: ".wb-menu", why: "工作台入口菜单：理想是 --z-float(20)，但 .preview-host(35) 占同一个右上角 ⇒ 降到 20 会被预览面板**视觉盖住**（面板 pointer-events:none，点击仍穿透 ⇒ 不会有测试变红，只会让用户看不见菜单）。这类「改了无法证明无回归」的项一律不碰。" },
  { file: "workbench.css", value: 24, sel: ".wb-host", why: "工作台面板宿主：贴边常驻且 pointer-events:none，理想是 --z-dock(10)。" },
  { file: "workbench.css", value: 2, sel: ".wb-resizer", why: "工作台分栏拖条：只在面板内部生效，不参与全站浮层之争。" },
  { file: "workbench.css", value: 3, sel: ".wb-drop-hint", why: "拖放高亮提示：只在工作台面板内部出现，不与任何浮层同屏。" },
  { file: "workerstrip.css", value: 25, sel: ".ws-strip", why: "worker 快捷条：相对序被 tests/w866 明确钉住（必须高于 .railv3(20) 且低于 .railv3-card(40)）⇒ 不能单独挪。" },
];

describe("W2007 · z-index 层级门禁", () => {
  it("① 层级令牌存在且严格有序（这条就是本 bug 的不变量）", () => {
    const t = tokenScale();
    for (const name of ["--z-scrim", "--z-drawer", "--z-settings", "--z-modal"]) {
      expect(t.has(name), `缺少层级令牌 ${name}`).toBe(true);
    }
    const scrim = t.get("--z-scrim")!;
    const drawer = t.get("--z-drawer")!;
    const settings = t.get("--z-settings")!;
    const modal = t.get("--z-modal")!;
    // 遮罩在下、抽屉在上（抽屉必须盖住遮罩，否则遮罩会盖住抽屉自己的内容）
    expect(scrim, "遮罩必须低于抽屉").toBeLessThan(drawer);
    // ★ 本次 bug 的核心不变量：设置页必须高于移动端抽屉
    expect(drawer, "移动端抽屉必须低于设置页（否则会话树盖住设置页）").toBeLessThan(settings);
    // 从设置页里打开的二级弹窗必须盖得住设置页
    expect(settings, "设置页必须低于二级弹窗（否则设置页里的弹窗被盖住）").toBeLessThan(modal);
  });

  it("② 关键选择器必须引用令牌，不许退回裸魔数（防「顺手改回 50」）", () => {
    const byFile = new Map(cssFiles().map((f) => [f.name, f.css]));
    /** 取某选择器块的正文（大括号配对）。 */
    const block = (css: string, sel: string): string => {
      const i = css.indexOf(sel);
      if (i < 0) throw new Error("selector not found: " + sel);
      const start = css.indexOf("{", i);
      let depth = 0;
      for (let j = start; j < css.length; j++) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}") {
          depth--;
          if (depth === 0) return css.slice(start + 1, j);
        }
      }
      throw new Error("unbalanced braces for " + sel);
    };
    const required: [string, string, string][] = [
      ["settings.css", ".settings-page", "--z-settings"],
      ["responsive.css", "#sidebar", "--z-drawer"],
      ["responsive.css", ".sidebar-scrim", "--z-scrim"],
      ["sessions.css", ".modal-scrim", "--z-modal"],
    ];
    for (const [file, sel, token] of required) {
      const body = block(byFile.get(file)!, sel);
      expect(body, `${file} 的 ${sel} 必须用 var(${token})`).toContain(`z-index: var(${token})`);
      expect(body, `${file} 的 ${sel} 不得再出现裸数字 z-index`).not.toMatch(/z-index:\s*\d/);
    }
  });

  it("③ 裸魔数棘轮：新增裸魔数即红，已登记的项收敛后必须从表里删掉", () => {
    const bare = decls().filter((d) => /^\d+$/.test(d.value));
    /**
     * ★ 按 (file, value, **条数**) 记账，不按 (file, value) 去重。
     * 为什么：只记「这个文件出现过 60」的话，在同一文件里**再加一处**裸 60 不会被发现
     * （集合去重把两处并成一处）—— 那正是「棘轮假绿」的经典形态。带条数后，
     * 同文件同值多写一处 ⇒ 计数不等 ⇒ 红。
     */
    const count = (ds: { file: string; value: number }[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const d of ds) {
        const k = d.file + "=" + String(d.value);
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return m;
    };
    const allowed = count(LEGACY_MAGIC);
    const actual = count(bare.map((d) => ({ file: d.file, value: Number(d.value) })));

    // 新增（表里完全没有的 file=value）⇒ 红
    const added = [...actual.keys()].filter((k) => !allowed.has(k)).sort();
    expect(added, "出现未登记的裸 z-index 魔数：请改走 tokens.css 的 --z-* 令牌，或登记进 LEGACY_MAGIC 并写明理由").toEqual([]);

    // 超量（同 file=value 比登记的多）⇒ 红
    const over = [...actual.entries()]
      .filter(([k, n]) => allowed.has(k) && n > allowed.get(k)!)
      .map(([k, n]) => k + " 实际 " + String(n) + " 处 > 登记 " + String(allowed.get(k)))
      .sort();
    expect(over, "同一文件内重复出现未登记的裸魔数（按条数记账才能抓到）").toEqual([]);

    // 陈旧：表里有、实际没有 ⇒ 红（收敛成 token 后忘了删表项 = 表在说谎）
    const stale = [...allowed.keys()].filter((k) => !actual.has(k)).sort();
    expect(stale, "LEGACY_MAGIC 里的条目已不存在（多半已收敛成 token）：请从表里删掉").toEqual([]);

    /**
     * 每条登记都必须写明理由。
     * 门槛取 10 字而不是 20：中文单字信息密度高，"拖放提示：局部层叠。" 这种
     * 已经说清了「它为什么不参与浮层之争」；真正的空洞登记是 "遗留" / "TODO" /
     * "待收敛" 这类**同义反复**，故用黑名单精确拦它们，而不是靠长度水门槛
     * （水门槛只会逼人把废话写长）。
     */
    const LAZY = /^(遗留|待收敛|历史遗留|TODO|FIXME|待办|暂时|先这样)[。.！!]*$/;
    for (const m of LEGACY_MAGIC) {
      expect(m.why.length, `${m.file} 的登记项必须写明为什么不收敛`).toBeGreaterThan(10);
      expect(LAZY.test(m.why), `${m.file} 的登记理由不能是 "${m.why}" 这种同义反复`).toBe(false);
      expect(m.sel.length, `${m.file} 的登记项必须写明选择器`).toBeGreaterThan(0);
    }
  });

  it("④ ★ 调包用例：把设置页层级改回 50 ⇒ 本门禁必须红（证明有牙）", () => {
    // 真实事故形态：settings.css 写回裸魔数 50（本次 bug 的原样）。
    const real = readFileSync(join(STYLES, "settings.css"), "utf8");
    const swapped = real.replace("z-index: var(--z-settings);", "z-index: 50;");
    expect(swapped, "前置：调包确实改了 CSS").not.toBe(real);
    // ② 的判据在调包后必须失败
    const body = swapped.slice(swapped.indexOf(".settings-page"));
    expect(body, "★ 裸 50 必须被 ② 抓到").not.toContain("z-index: var(--z-settings)");
    // ③ 的判据在调包后也必须失败（50 不在 LEGACY_MAGIC 的 settings.css 条目里）
    const allowed = new Set(LEGACY_MAGIC.map((m) => m.file + "=" + String(m.value)));
    expect(allowed.has("settings.css=50"), "★ 裸 50 未登记 ⇒ ③ 会报新增").toBe(false);
  });

  it("⑤ ★ 调包用例：令牌序被写反（抽屉 > 设置页）⇒ ① 必须红", () => {
    const t = tokenScale();
    const swapped = new Map(t);
    swapped.set("--z-settings", 10); // 模拟"设置页又比抽屉低"
    expect(swapped.get("--z-drawer")!, "★ 抽屉高于设置页必须被 ① 抓到").toBeGreaterThan(swapped.get("--z-settings")!);
    // 对照：真实值不满足该不等式（即 ① 在真实 CSS 上是通过的）
    expect(t.get("--z-drawer")!).toBeLessThan(t.get("--z-settings")!);
  });
});
