// ============================================================================
// statusline/dock.ts — W1462：**胶囊之外**贴底信息行的渲染收口。
//
// 背景：用户要求「会话名 · 空闲 · tok/s · 第几轮 放到消息框胶囊外的底部平铺，灰色不显眼」。
// tok/s（#slTps）/ 缓存（#slCache）/ 步数（#slSteps）随之从 #statusline 搬进 #statusbar，
// 于是出现两个只有这里才知道的事实，必须**同一个模块**持有，否则迟早对不上：
//   ① 这三个节点的宿主不再是 #statusline ⇒ 取节点不能再用 this.el 作用域
//      （真实事故：作用域没放开 → need() 抛 missing element → 整页白屏）；
//   ② /api/status 不可用时的降对比（.sl-stale）要打到**实际宿主**上，
//      否则这三项在 stale 态看起来「是活的」。
//
// 本模块只做「取节点 + 写值 + 降对比」，不持有轮询/快照（那仍在 statusline.ts）。
//
// ----------------------------------------------------------------------------
// W-reac（本次改造）：三项的**状态**提为 signal，DOM 由各自 effect 精确更新。
//
//   改造前：`render(snapshot, session)` 一次把三项都写一遍。
//   改造后：`render(...)` 只写**状态**，三条 effect 各自负责一个节点 ——
//           「哪一项变了」不再需要读完整 `render` 才知道，新增一项也只需
//           加一个 signal + 一条 effect，不必改 `render` 的调用方。
//
//   ★ 诚实说明边界：本模块只有 3 个字段、2 秒一次轮询，**性能收益可忽略** ——
//     这次改动的价值在结构与可测性（状态与 DOM 分离），不是"更快"。
//   ★ 真正的「一个 stale、两个宿主」问题（#statusline + #statusbar）**本模块解不掉**：
//     两个宿主分属两个文件。这里把 stale 暴露为 `staleSignal`（只读），
//     将来 statusline.ts 改成订阅它时才算真正消灭「漏一处就是假活」（其事故史见 W1462）。
// ============================================================================
import { effect, signal, type ReadonlySignal } from '../reactive';
import { fixed1 } from './icons';
import { renderCacheCell } from './ring';
import { createTpsSamples, pushTpsSamples, tpsDisplay, type TpsSamples } from './tps';
import { t } from '../i18n';
import type { StatusSnapshot, UsageSnapshot } from '../types';

/** 贴底信息行宿主（#statusbar）；老夹具没有该节点时为 null（安静降级，不 throw）。 */
function dockHost(): HTMLElement | null {
  return document.getElementById('statusbar');
}

/** tok/s 单元格的完整外观（文本 + 悬停标题一起换，不留半截状态）。 */
interface TpsView {
  text: string;
  title: string;
}

export class DockCells {
  /** W789：吞吐的近期采样缓冲（按会话隔离，跨切换保留）。 */
  private readonly tpsCache = new Map<string, TpsSamples>();

  /** 三个数值格的宿主；缺一即抛（id 是运行时真源，不允许静默缺失）。 */
  private readonly tpsEl = needCell('slTps');
  private readonly cacheEl = needCell('slCache');
  private readonly stepsEl = needCell('slSteps');

  // ── 三项的状态（只由 render/setStale 写，DOM 只由下面四条 effect 写） ──
  private readonly tpsView = signal<TpsView>({ text: '', title: '' });
  private readonly cacheUsage = signal<UsageSnapshot | undefined>(undefined);
  private readonly stepsText = signal<string>('');
  private readonly stale = signal(false);

  /** 四条绑定：一条 effect 一个关注点（render 不再需要知道 DOM 长什么样）。 */
  private readonly disposers: readonly (() => void)[] = [
    effect(() => {
      const v = this.tpsView.get();
      this.tpsEl.textContent = v.text;
      this.tpsEl.title = v.title;
      this.tpsEl.setAttribute('aria-label', t('statusline.tpsAria', { text: v.text }));
    }),
    // W263 缓存命中率：只改文本（铁律 1/2/5——不重建 DOM，不重渲染背景）
    effect(() => {
      renderCacheCell(this.cacheEl, this.cacheUsage.get());
    }),
    effect(() => {
      const text = this.stepsText.get();
      this.stepsEl.textContent = text;
      this.stepsEl.setAttribute('aria-label', text);
    }),
    // /api/status 不可用：整条降低对比（宿主 = 贴底信息行，宿主缺失时安静 no-op）
    effect(() => {
      dockHost()?.classList.toggle('sl-stale', this.stale.get());
    }),
  ];

  /**
   * stale 的**只读信号**。
   *
   * 暴露它不是为了本模块 —— 而是为 #statusline 那个**另一个宿主**准备的：
   * 目前它由 statusline.ts 手工同步（`this.el.classList`），漏一处就是「假活」（W1462）。
   * 将来 statusline.ts 订阅这里即可由两处手写降为一处声明。
   */
  get staleSignal(): ReadonlySignal<boolean> {
    return this.stale.readonly();
  }

  /** 写一轮快照：tok/s（含近期均值回退）、缓存命中、步数。只写状态，DOM 由 effect 跟上。 */
  render(snapshot: StatusSnapshot, session: string): void {
    // W789：吞吐 —— 有效采样原样显示；服务端给 0/缺省（会话 inactive）时显示最近
    // N 次采样的均值并带 `≈` 前缀，不再从「42.5 tok/s」直接跳成「0.0 tok/s」。
    const samples = pushTpsSamples(this.samplesFor(session), snapshot.tokens_per_sec);
    this.tpsCache.set(session, samples);
    this.tpsView.set(tpsDisplay(samples, snapshot.tokens_per_sec, snapshot.busy === true, fixed1));
    this.cacheUsage.set(snapshot.usage);

    const steps = snapshot.steps;
    this.stepsText.set(
      typeof steps === 'number' && steps >= 1 ? t('statusline.steps', { n: steps }) : t('statusline.stepsNone')
    );
  }

  /**
   * /api/status 不可用：整条降低对比。宿主 = 贴底信息行（这三项已不在 #statusline）。
   * on=false 时复位。宿主缺失（老夹具）⇒ 安静 no-op。
   */
  setStale(on: boolean): void {
    this.stale.set(on);
  }

  /** 注销全部绑定（当前 Statusline 是单例、不调用它；留给将来可销毁的宿主）。 */
  dispose(): void {
    for (const off of this.disposers) off();
  }

  /** W789：本会话的吞吐采样缓冲（首次访问即建，按会话隔离）。 */
  private samplesFor(id: string): TpsSamples {
    const cur = this.tpsCache.get(id);
    if (cur) return cur;
    const fresh = createTpsSamples();
    this.tpsCache.set(id, fresh);
    return fresh;
  }
}

/** 取一个贴底信息行里的数值格（document 作用域 —— 它们不在 #statusline 内）。 */
function needCell(id: string): HTMLElement {
  const n = document.getElementById(id);
  if (!n) throw new Error('missing element: #' + id);
  return n;
}
