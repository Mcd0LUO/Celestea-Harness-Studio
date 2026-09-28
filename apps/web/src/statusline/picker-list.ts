// ============================================================================
// statusline/picker-list.ts — W870：模型 / 推理档位**清单渲染**（离屏构建 + 单次
//   替换，铁律 1）。从 ./picker.ts 拆出，纯搬运（DOM 结构、类名、文案、事件均未改）；
//   拆出的原因是 picker.ts 触到前端模块体积门禁的 400 行上限，而 W870 的会话级模型
//   切换必须在同一文件里长出分支。
//
//   与 ./picker.ts 的分工：本模块只画（含 W870 的「本会话已固定模型」说明行），
//   点击行为经 ./picker-shared.ts 的 ListHooks 交回调用方；因此本模块**不** import
//   ./picker.ts，也就没有环。
// ============================================================================
import { el } from '../utils/dom';
import type { ConfigInfo, ModelInfo } from '../types';
import { modelIconEl } from './icons';
import { effortOptions, otherGroupLabel, type ListHooks, type ModelPick, type PickerHost, type SwitchKind } from './picker-shared';
import { t } from '../i18n'; // i18n P1-a

/**
 * 渲染清单（离屏构建 + 单次替换，铁律 1）。
 * `cfg` 可以来自配置缓存（同步首屏）或一次真实拉取，渲染结果与来源无关。
 */
export function renderList(body: HTMLElement, kind: SwitchKind, cfg: ConfigInfo, host: PickerHost, hooks: ListHooks): void {
  if (kind === 'effort') {
    renderEffortList(body, sessionTruthEffort(cfg, host), hooks);
    return;
  }
  renderModelList(body, cfg, host, hooks);
}

/**
 * W2059：清单「当前模型」= **会话真值**，不是全局默认。
 *
 * 为什么必须分开：`cfg` 来自 GET /api/config，那是**全局默认**（config-shape.ts
 * configView 读 deps.runtime.profile()）；而状态栏徽标的模型来自
 * GET /api/status?session=<聚焦会话>，即会话实例的 profile（全局 base +
 * session.json.model 覆盖）。旧写法 `cfg.model ?? host.snapshotModel` 的 `??`
 * 右支**永不触发**（cfg.model 永远非空），于是带覆盖的会话打开选择器时高亮的是
 * 全局默认 —— 用户看到的「切换了模型，显示的还是 deepseek」。
 *
 * 回落规则（两个方向都保留，不许只留一边）：
 *   · 有聚焦会话（sessionId !== ''）⇒ 会话快照是会话真值；快照还没回来（首轮轮询
 *     未到）时才退回全局，因为那时本地确实没有更好的来源。
 *   · 无聚焦会话（旧单会话容器）⇒ 会话真值**就是**全局，cfg.model 优先。
 */
export function sessionTruthModel(cfg: ConfigInfo | null, host: PickerHost): string {
  if (host.sessionId === '') return cfg?.model ?? host.snapshotModel ?? '';
  return host.snapshotModel !== '' ? host.snapshotModel : (cfg?.model ?? '');
}

/**
 * W2059：推理档位的「当前值」。
 *
 * 与模型不同：**档位没有会话级概念** —— session.json 只存 model（见
 * runtime/session-compose.ts 的 sessionOverrides，只读 sessionModel 与
 * sessionSystemPrompt），PUT /api/sessions/{id}/model 也只写 model。所以
 * GET /api/config 的 reasoning_effort 对每个会话都是真值。
 *
 * 这里仍优先取状态栏快照里**已上报**的档位：用户点开弹层时，高亮必须与他正看着的
 * 徽标一致；快照为 null（标准档 / 尚未轮询）时退回全局配置（全局是唯一真源）。
 */
export function sessionTruthEffort(cfg: ConfigInfo | null, host: PickerHost): string {
  return host.snapshotEffort ?? cfg?.reasoning_effort ?? '';
}

/**
 * 推理档位清单（W795 抽出）：候选全是静态常量 + 一个「当前」值 ⇒ 不依赖任何请求，
 * 冷启动也能同一帧画出来（乐观渲染），所以它与模型清单分成两个渲染器。
 */
export function renderEffortList(body: HTMLElement, current: string, hooks: ListHooks): void {
  const off = document.createElement('div');
  const options = [...effortOptions()];
  const cur = current;
  if (cur && !options.some((o) => o.value === cur)) {
    options.push({ value: cur, label: cur + t('statusline.picker.currentSuffix') });
  }
  for (const o of options) {
    off.appendChild(optButton(o.label, o.value ?? '', cur, () => hooks.apply({ reasoning_effort: o.value })));
  }
  body.replaceChildren(...off.childNodes);
}

export function renderModelList(body: HTMLElement, cfg: ConfigInfo, host: PickerHost, hooks: ListHooks): void {
  const off = document.createElement('div');

  // ---- model：按提供商分组的树状清单（W262） ----
  const models = Array.isArray(cfg.available?.models) ? cfg.available.models : [];
  const cur = sessionTruthModel(cfg, host);
  if (!models.length) {
    // 清单缺失 → 内联文本输入降级
    const row = el('div', 'sl-popup-textrow');
    const input = el('input', 'sl-popup-input') as HTMLInputElement;
    input.placeholder = t('statusline.picker.modelName');
    input.value = cur;
    row.appendChild(input);
    const applyBtn = el('button', 'btn btn-accent btn-mini', t('statusline.picker.apply')) as HTMLButtonElement;
    applyBtn.addEventListener('click', () => {
      const v = input.value.trim();
      // W870：手工输入也是**切模型**，所以同样走 hooks.pick（会话级 / 全局由宿主决定）
      // —— 若走 hooks.apply 就会退回全局 POST /api/config，在带覆盖的会话上正是那个 bug。
      if (v !== '' && v !== cur) hooks.pick({ model: v, providerId: '' });
    });
    row.appendChild(applyBtn);
    off.appendChild(row);
    off.appendChild(el('div', 'sl-popup-note', t('statusline.picker.enterModel')));
    appendFixedNote(off, host);
    body.replaceChildren(...off.childNodes);
    return;
  }
  const known = models.some((m) => m.id === cur);
  if (cur && !known) {
    // 当前模型不在清单里（自定义端点）→ 置顶一行，仍可点回
    off.appendChild(optButton(cur + t('statusline.picker.currentSuffix'), cur, cur, () => hooks.apply({ model: cur })));
    const sep = el('div', 'sl-popup-sep');
    sep.textContent = t('statusline.picker.candidates');
    off.appendChild(sep);
  }
  // W750：当前生效项 = 后端标注的 active 行（同模型 + 同端点）。旧服务没有该
  // 字段时退回「按模型 id 匹配」；两者都没有 → 没有选中态，也不虚标。
  //
  // W2059：`active` 是**按全局 profile 标注**的 —— config-shape.ts 的
  // availableModels() 用 deps.runtime.profile().model 与 baseUrlOf() 判定，
  // 拿不到聚焦会话的覆盖。所以带覆盖的会话里它标的正是全局默认，直接信它就会把
  // 高亮钉在 deepseek 上（用户报案的另一半）。有聚焦会话时改用会话真值匹配的那一
  // 行；无聚焦会话时全局即真值，沿用后端 active（同模型 + 同端点，比裸 id 更准）。
  const truthRow = models.find((m) => m.id === cur) ?? null;
  const activeRow = host.sessionId === '' ? (models.find((m) => m.active === true) ?? null) : truthRow;
  const currentProviderId = (activeRow?.provider_id ?? '').trim();
  const isCurrent = (m: ModelInfo): boolean =>
    host.sessionId === '' && activeRow !== null ? m.active === true : m === truthRow;
  // 树状一级 = provider 显示名（后端已保证模型名未定义时取 id）。
  // W750：同一 provider id 的记录聚成一组（显示名可能重复/被改，用 id 做键），
  // 缺 provider 字段的记录（静态兜底目录 / 旧数据）归入「其他」组。
  const groups: { pid: string; name: string; list: ModelInfo[] }[] = [];
  const byPid = new Map<string, { pid: string; name: string; list: ModelInfo[] }>();
  for (const m of models) {
    const pid = (m.provider_id ?? '').trim();
    const name = (m.provider ?? '').trim() || (pid !== '' ? pid : otherGroupLabel());
    const key = pid !== '' ? pid : name;
    let group = byPid.get(key);
    if (!group) {
      group = { pid, name, list: [] };
      byPid.set(key, group);
      groups.push(group);
    }
    group.list.push(m);
  }
  appendFixedNote(off, host);
  for (const group of groups) {
    off.appendChild(groupRow(group.name, group.pid, group.list.some(isCurrent)));
    for (const m of group.list) {
      const pick: ModelPick = {
        model: m.id,
        // 显示名不是 id：只有拿到稳定 id 且与当前 provider 不同才需要先切 provider。
        providerId: (() => {
          const pid = (m.provider_id ?? '').trim();
          return pid !== '' && pid !== currentProviderId ? pid : '';
        })(),
      };
      off.appendChild(optButton(m.name || m.id, m.id, isCurrent(m) ? m.id : '', () => hooks.pick(pick), true));
    }
  }
  body.replaceChildren(...off.childNodes);
}

/**
 * W870：该会话**有**自己的 `session.json.model` 时如实说一行。
 *
 * 为什么必须有：徽标的 model 来自会话实例的 profile（全局 base + 会话覆盖），
 * 所以这样的会话**本来就不跟**全局默认走。用户点开选择器时若不说明，就会把
 * 「切了全局、这个会话却没变」当成又一个 bug（那正是 W870 报案的另一半）。
 * 只在有聚焦会话且确实带覆盖时出现 —— 无覆盖的会话零改动、零噪音。
 */
function appendFixedNote(off: HTMLElement, host: PickerHost): void {
  if (!host.sessionModelFixed || host.sessionId === '') return;
  off.appendChild(el('div', 'sl-popup-note', t('statusline.picker.fixed')));
}

/**
 * W778：缓存清单与后台校验结果是否一致（不一致才允许原地替换）。
 * 只比对本渲染器真正用到的字段：档位看 reasoning_effort，模型看当前模型 + 清单。
 */
export function listChanged(kind: SwitchKind, a: ConfigInfo, b: ConfigInfo): boolean {
  if (kind === 'effort') return (a.reasoning_effort ?? '') !== (b.reasoning_effort ?? '');
  return (
    (a.model ?? '') !== (b.model ?? '') ||
    JSON.stringify(a.available?.models ?? []) !== JSON.stringify(b.available?.models ?? [])
  );
}

/**
 * W262：树状分组标题行 —— 提供商显示名，不可点击（无 button/无监听）。
 * W750：组内含当前生效项时标一个「当前」；display name 与稳定 id 不同名时
 * 把 id 一并淡显，免得两个 provider 显示名相似时看不出切的是哪一个。
 */
function groupRow(provider: string, providerId: string, cur: boolean): HTMLElement {
  const row = el('div', 'sl-group' + (cur ? ' cur' : ''));
  row.appendChild(el('span', 'sl-group-name', provider));
  if (providerId !== '' && providerId !== provider) {
    row.appendChild(el('span', 'sl-group-id', providerId));
  }
  if (cur) row.appendChild(el('span', 'sl-group-tag', t('statusline.currentTag')));
  return row;
}

/** 模型/档位一行；`sub=true` = 树状缩进一级（provider 组下的模型行）。 */
function optButton(
  label: string,
  value: string,
  current: string,
  onPick: () => void,
  sub = false,
): HTMLElement {
  const cls =
    'sl-opt' +
    (sub ? ' sub' : '') +
    (value !== '' && value === current ? ' current' : '');
  const b = el('button', cls) as HTMLButtonElement;
  // W750：模型行前置家族图标（未识别 → 不加节点，不占位）。
  const icon = modelIconEl(value);
  if (icon !== null) b.appendChild(icon);
  b.appendChild(el('span', 'sl-opt-name', label));
  if (value !== '') b.appendChild(el('span', 'sl-opt-val', value));
  if (value !== '' && value === current) b.appendChild(el('span', 'sl-opt-tag', t('statusline.currentTag')));
  b.addEventListener('click', onPick);
  return b;
}
