// ============================================================================
// ui/workbench/browser.ts — G4：浏览器面板（iframe 指向用户输入的 URL）。
// ----------------------------------------------------------------------------
// P0：一个 iframe + URL 输入 + 「打开」+「在新标签打开」。跨域站点若用
//   X-Frame-Options / CSP frame-ancestors 拒绝被嵌入，父页面**读不到原因**
//   （跨域），所以用「加载超时 ⇒ 可读提示」的保守判定：超时未 load 就提示
//   「这个网站可能不允许被嵌入」并给「在新标签打开」出口，不留白屏、不静默。
// 竞态：每次导航取面板新 seq；晚到的旧 load/超时事件丢弃。
//
// ★★ W2057（用户原话：「打开网页链接应该自动打开我们提供的浏览器而非新建页面」）
//    真机复核后**修的是哪一件、以及为什么不是另一件**（报告 §2 有完整数据）：
//
//   本遍要把「正文外链」接到本面板上，所以先量了本面板的降级到底生不生效。
//   实测结论与**我的第一版判断相反**，如实登记：
//     · iframe 的 `load` 事件对**成功与失败一视同仁** —— X-Frame-Options: DENY、
//       CSP frame-ancestors 'none'、端口根本不存在，三者实测 `loads === 1`
//       （9ms / 8ms / 7ms 就来了）。所以上面那条超时降级对**这些**站点确实不触发。
//     · 但「超时判据」本身**没有坏**：唯一真正需要超时的是「服务器接了 TCP 却
//       永不响应」（实测挂起服务器 `loads === 0`）—— 那条路径降级**照常生效**。
//     · 我一度以为这是「about:blank 的 load 被误当成导航的 load」的竞态，于是换了
//       一个判据（`contentWindow.length`）。**那是错的**：真机实测
//       `contentWindow.length` 对**加载成功**的文档同样是 0（它是**子框架个数**，
//       不是元素个数），对同源成功与跨域被拒**取同一个值** ⇒ 它什么也区分不了。
//       该改法已废弃，未进入本次提交（改动只落在下面 external 那一处）。
//
//   ⇒ 真正可修、且**只有这一件**可修的是：**被拒时父页面无法判定，因此不该假装
//     能判定**。跨域被拒与「跨域但加载成功」在父页面侧**完全不可区分**（实测：
//     contentDocument 都是 null、contentWindow 的属性都抛 SecurityError、
//     PerformanceResourceTiming 都是 responseStatus 0）。所以正确的修法不是
//     换一个「更聪明的判据」（不存在），而是**把出口做成永远可用**：
//     「在新标签打开」按钮不再只在降级时出现，而是**常驻**。
//     于是无论 iframe 是被拒、还是加载慢、还是用户就是想要一个真标签页，
//     出口都在同一处、同一次点击可达 —— 这才是 W2051 说的「用户仍有路走」。
//
//   ★ 代价与诚实登记：常驻按钮占一行位置（CSS 见 workbench.css 的 .wb-url-external）。
//     面板因此比改动前多一个常驻控件；换到的是「被拒时不再只有白屏」。
// ============================================================================
import { el } from '../../utils/dom';
import { nextSeq, type PanelState } from './state';
import { isImeKey } from '../ime'; // W2033：组合中的 Enter 是「确认候选词」，不是「打开这个 URL」
import { t } from '../../i18n';

let loadTimeoutMs = 4000;

/** 测试可调：加载超时阈值（毫秒）。 */
export function setLoadTimeout(ms: number): void {
  loadTimeoutMs = ms;
}

function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (s === '') return '';
  if (/^https?:\/\//i.test(s)) return s;
  return 'https://' + s;
}

/** 渲染浏览器面板内容。 */
export function renderBrowserPanel(body: HTMLElement, panel: PanelState, isCurrent: (id: string, seq: number) => boolean): void {
  const data = panel.data as unknown as { url?: string } | undefined;
  const current = data && typeof data.url === 'string' ? data.url : '';
  const off = document.createElement('div');
  const row = el('div', 'wb-url-row');
  const input = el('input', 'wb-url-input') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = t('chat.wb.urlPlaceholder');
  input.value = current;
  const open = el('button', 'wb-btn wb-url-open', t('chat.wb.open')) as HTMLButtonElement;
  open.type = 'button';
  // ★ W2057：出口**常驻**（不再带 hidden）。理由见文件头：跨域被拒在父页面侧
  //   不可判定，所以「什么时候需要这个出口」不可知 ⇒ 让它一直在。
  //   文案沿用既有的 chat.wb.openExternal（「在新标签打开」），不新增 key。
  //
  //   ★ 它放在 **URL 行里**（不是 frame 之后）：真机截图抓到的布局缺陷 ——
  //   .wb-frame 的高度是 calc(100% - 34px)，所以任何排在它**后面**的兄弟节点
  //   都会被推到可视区之外（面板需要滚动才看得到）。出口的全部意义就是
  //   「被拒时用户仍有路走」，看不见等于没有 ⇒ 必须与「打开」同排常驻。
  const external = el('button', 'wb-btn wb-url-external', t('chat.wb.openExternal')) as HTMLButtonElement;
  external.type = 'button';
  row.appendChild(input);
  row.appendChild(open);
  row.appendChild(external);
  off.appendChild(row);
  const notice = el('div', 'wb-notice hidden');
  off.appendChild(notice);
  const frame = el('iframe', 'wb-frame') as HTMLIFrameElement;
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
  off.appendChild(frame);
  body.replaceChildren(...Array.from(off.childNodes));

  /** 提示行（只改文本；出口按钮**不再**随它显隐，见上）。 */
  const show = (text: string): void => {
    notice.textContent = text;
    notice.classList.remove('hidden');
  };

  const navigate = (raw: string): void => {
    const url = normalizeUrl(raw);
    if (url === '') return;
    panel.data = { url } as unknown as Record<string, unknown>;
    const seq = nextSeq(panel.id);
    notice.classList.add('hidden');
    let done = false;
    frame.addEventListener('load', () => {
      if (!isCurrent(panel.id, seq)) return;
      done = true;
    });
    frame.src = url;
    window.setTimeout(() => {
      if (!isCurrent(panel.id, seq) || done) return;
      // 跨域下无法读具体原因：保守提示「可能不允许被嵌入」并给出口。
      show(t('chat.wb.frameBlocked'));
    }, loadTimeoutMs);
  };

  open.addEventListener('click', () => navigate(input.value));
  input.addEventListener('keydown', (e) => {
    // W2033：IME 组合中的 Enter 属于输入法（域名/搜索词可能是中文）。
    if (isImeKey(e)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      navigate(input.value);
    }
  });
  // ★ W2057：出口读**当前**输入框的值（不是导航那一刻的值）—— 用户改了地址再点
  //   出口，应当开他**现在**写的那个；这也是「常驻」之后的自然语义。
  //   监听只挂一次（原实现挂在 show() 里，每次降级都会叠一个 —— 那在降级是死代码
  //   时看不出来，现在出口常驻就更不能那样写）。
  external.addEventListener('click', () => {
    const url = normalizeUrl(input.value);
    if (url !== '') window.open(url, '_blank', 'noopener');
  });
  if (current !== '') navigate(current);
}