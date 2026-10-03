// ============================================================================
// ui/providers/form.ts — 提供商表单 DOM 构建（弹窗「添加」与行内联「编辑」复用）
//   W748 从 ui/providers.ts 拆出；纯搬运，DOM 结构/类名/文案/事件一行未改。
//   字段与操作行在本模块；单模型行见 ./modelrow，二级选择窗见 ./picker。
// ============================================================================
import { ApiError, api, userErrorText } from '../../api';
import { el } from '../../utils/dom';
import type { ProviderInfo, ProviderModelSpec } from '../../types';
import { addModelRow } from './modelrow';
import { openModelPicker } from './picker';
import { fmtErr } from './state';
import { t } from '../../i18n';
import type { EditorRefs, FormHooks, ProviderPayload } from './types';

const FORMATS: readonly { value: string; label: string }[] = [
  { value: 'chat_completions', label: 'Chat Completions' },
  { value: 'responses', label: 'Responses' },
  { value: 'anthropic_messages', label: 'Anthropic Messages' },
];
function buildPayload(e: EditorRefs): ProviderPayload {
  // F4-04：**两列都空**（点了「+ 添加模型」但没填 id/名称）才跳过。
  // 旧过滤是 `id || name`（**或**），于是「只填了显示名、id 空着」的半填行也会进
  // payload，而 `name` 取到那个显示名 —— 但后端 parseModel 因 `id === ''` 让整行
  // `return null`（apps/studio/src/store/providers.ts:287）⇒ 用户填的显示名连同整行
  // **静默消失**，界面不给任何提示。半填不是空行：它带着用户已经输入的东西。
  // 改判据成「与」：半填行留在 payload 里，由下面 modelIdRequired 显式拒绝并说清原因。
  const models: ProviderModelSpec[] = e.rows
    .filter((r) => r.id.value.trim() !== '' || r.name.value.trim() !== '')
    .map((r) => ({
      id: r.id.value.trim(),
      name: r.name.value.trim() || r.id.value.trim(),
      // W258 任务 3：档位片多选 → 数组（后端契约不变）
      reasoning_efforts: r.efforts.values(),
      context_window: numOrNull(r.ctx),
      max_output_tokens: numOrNull(r.maxOut),
      // W1536：输入/输出类型。**未触碰 = 不写这个键**（保持乐观默认，providers.json
      // 与 schema default 一致）；一旦用户点过，写回的就是他勾的集合本身（可为 []）。
      // 后端 parseModel/modalityList 对空数组返回 undefined ⇒ 空集会被归一成缺省，
      // 见报告「已知边界」。
      ...spreadModalities('input_modalities', r.inputModalities.values()),
      ...spreadModalities('output_modalities', r.outputModalities.values()),
    }));
  const key = e.key.value.trim();
  return {
    // W262: 编辑既有记录时沿用原始 id；仅新建时由名称派生。
    id: e.originalId ?? e.name.value.trim(),
    name: e.name.value.trim(),
    note: e.note.value.trim(),
    base_url: e.url.value.trim(),
    request_format: e.format.value,
    ...(key !== '' ? { api_key: key } : {}),
    models,
  };
}

/** W1536：undefined（未触碰）⇒ 不带该键；数组 ⇒ 原样带上。 */
function spreadModalities(
  key: 'input_modalities' | 'output_modalities',
  values: string[] | undefined,
): Partial<ProviderModelSpec> {
  return values === undefined ? {} : { [key]: values };
}

function numOrNull(i: HTMLInputElement): number | null {
  // W262: 支持 k / m 后缀（1k=1000，1m=1000000，1.5m=1500000，大小写与空格容错）
  const t = i.value.trim().toLowerCase().replace(/\s+/g, '');
  if (t === '') return null;
  const m = /^(\d+(?:\.\d+)?)([km])?$/.exec(t);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base) || base < 0) return null;
  const mult = m[2] === 'k' ? 1_000 : m[2] === 'm' ? 1_000_000 : 1;
  const n = Math.round(base * mult);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
/**
 * 半填模型行：填了**显示名**却没填 **id**（F4-04）。
 *
 * 为什么它必须被拦下来而不是丢掉：后端 `parseModel` 遇 `id === ''` 整行 `return null`
 *（apps/studio/src/store/providers.ts:287），所以这一行在保存时会**静默消失** —— 用户
 * 填好的显示名没有任何去处，界面也不会提示。空行（两列都空）才是「没在编辑」，允许跳过。
 *
 * 返回那行的显示名（用于错误文案），没有半填行则 null。
 */
function halfFilledRow(e: EditorRefs): string | null {
  for (const r of e.rows) {
    const id = r.id.value.trim();
    const name = r.name.value.trim();
    if (id === '' && name !== '') return name;
  }
  return null;
}
/**
 * 一次 `POST /api/providers` 的成功判定（F4-03）。**两条路径共用一个口径**。
 *
 * 为什么需要它：`api.ts` 的 `requestJson` 对 4xx/5xx 抛 `ApiError`，但
 * **HTTP 200 + `{ok:false,error}` 不会抛** —— 那是 `ClearResp`（types/batch.ts 的
 * `OkResp`）契约允许的形状。保存按钮早就判了 `r.ok === false`，而「获取模型」的
 * 预保存链 `.then(() => …)` 直接把 resolve 当成成功，于是保存被拒也会继续拉模型，
 * 用户拿到基于**旧配置**的模型清单却以为保存好了。
 *
 * 通过时原样返回回执（不吞）；被拒时抛 `ApiError`，由各调用点的 `.catch` 渲染，
 * 于是「获取模型」与「保存」对同一个失败给出同样诚实的结果。
 */
function checkSaved(r: { ok?: boolean; error?: string }): { ok?: boolean; error?: string } {
  if (r.ok === false) {
    // 自己拼文案，**不走 userErrorText**：那个函数对非 ApiError 的入参只回固定措辞
    // （api.ts 的 userErrorText：字符串入参被 console.warn 记下后丢弃，返回 phrase），
    // 200+ok:false 的 error 字段本来就只是字符串 ⇒ 原因会整个丢掉。
    const detail = typeof r.error === 'string' ? r.error.trim() : '';
    const reason = detail === '' ? t('settings.common.checkInput') : detail;
    throw new ApiError(t('settings.providers.saveFailed', { reason }));
  }
  return r;
}
/**
 * 新建 provider 时「获取模型」要落的那一行的**最小载荷**（F4-01）。
 *
 * 后端 `POST /api/providers/{id}/models/fetch` 用路径参数 `store.find(id)` 读既有行，
 * 所以新建流程必须先有这一行才能探测。但它只需要「能连上并说话」的那几个字段：
 * 身份、地址、请求格式、Key。**刻意不带 models** —— 探测返回的清单经二级选择窗
 * 由用户勾选后进表单，那一刻还没点保存；把未勾选的模型也写下去会让用户以为
 * 「获取模型」= 保存。`models: []` 是契约里合法的空列表（store 的 validate 接受）。
 *
 * `api_key` 沿用 buildPayload 的规则：空 = 不带这个键（后端 keep-on-default）。
 */
function buildProbeRow(e: EditorRefs): ProviderPayload {
  const key = e.key.value.trim();
  return {
    id: e.name.value.trim(),
    name: e.name.value.trim(),
    note: e.note.value.trim(),
    base_url: e.url.value.trim(),
    request_format: e.format.value,
    ...(key !== '' ? { api_key: key } : {}),
    models: [],
  };
}
export function buildProviderForm(p: ProviderInfo | null, hooks: FormHooks): EditorRefs {
  const root = el('div', 'prov-form');

  const status = el('div', 'prov-editor-status');
  root.appendChild(status);

  const field = (label: string, ctrl: HTMLElement): HTMLElement => {
    const row = el('label', 'prov-field');
    row.appendChild(el('span', 'prov-field-label', label));
    row.appendChild(ctrl);
    return row;
  };

  const name = el('input', 'cfg-input') as HTMLInputElement;
  name.placeholder = t('settings.providers.idPlaceholder');
  name.value = p?.name ?? '';
  root.appendChild(field(t('settings.field.name'), name));

  const note = el('input', 'cfg-input') as HTMLInputElement;
  note.placeholder = t('settings.providers.notePlaceholder');
  note.value = p?.note ?? '';
  root.appendChild(field(t('settings.providers.note'), note));

  const key = el('input', 'cfg-input') as HTMLInputElement;
  key.type = 'password';
  key.placeholder = p ? t('settings.providers.keyPlaceholderExisting') : 'API Key';
  key.value = '';
  root.appendChild(field('API Key', key));

  const url = el('input', 'cfg-input') as HTMLInputElement;
  url.placeholder = 'https://…/v1';
  url.value = p?.base_url ?? '';
  const testBtn = el('button', 'btn btn-soft btn-mini', t('settings.providers.requestTest')) as HTMLButtonElement;
  testBtn.type = 'button';
  const urlRow = el('div', 'prov-urlrow');
  urlRow.appendChild(url);
  urlRow.appendChild(testBtn);
  root.appendChild(field(t('settings.providers.apiUrl'), urlRow));

  const format = document.createElement('select');
  format.className = 'cfg-input';
  for (const f of FORMATS) {
    const o = document.createElement('option');
    o.value = f.value;
    o.textContent = f.label;
    format.appendChild(o);
  }
  if (p?.request_format) {
    const known = FORMATS.some((f) => f.value === p.request_format);
    if (!known) {
      const o = document.createElement('option');
      o.value = p.request_format;
      o.textContent = p.request_format;
      format.appendChild(o);
    }
    format.value = p.request_format;
  }
  root.appendChild(field(t('settings.providers.requestFormat'), format));

  // ---- 模型列表 ----
  const modelsHead = el('div', 'prov-models-head');
  modelsHead.appendChild(el('span', 'prov-models-title', t('settings.field.model')));
  const fetchBtn = el('button', 'btn btn-soft btn-mini', t('settings.providers.fetchModels')) as HTMLButtonElement;
  fetchBtn.type = 'button';
  fetchBtn.title = t('settings.providers.fetchModelsHint');
  modelsHead.appendChild(fetchBtn);
  root.appendChild(modelsHead);
  const modelsBox = el('div', 'prov-models');
  root.appendChild(modelsBox);

  const e: EditorRefs = {
    root, name, note, key, url, format, modelsBox, status, rows: [], onLayout: hooks.onLayout,
    originalId: p?.id,
  };

  for (const m of p?.models ?? []) {
    addModelRow(e, m.id, m.name);
    const r = e.rows[e.rows.length - 1]!;
    // W258 任务 3 / W9107：已有模型的 reasoning_efforts 映射到对应档位片。
    //
    // W9202 更正：这里**没有**「undefined = 未配置 ⇒ 乐观默认三片全选」这一态。
    //   · 后端 store/providers.ts 的 `ProviderModel.reasoning_efforts` 是**必填** `string[]`，
    //     `parseModel` 对 providers.json 里**缺失**该键的行归一成 `[]`；
    //     public view 的 `view()` 又写死 `[...m.reasoning_efforts]` ⇒ 前端拿到的**永远是数组**。
    //   · 于是 `[]` 只有一个语义：该模型不支持推理（handlers/config.ts 的
    //     `isReasoningCapable` 判 `length > 0`）。旧注释描述的是 API 不存在的状态，
    //     曾把测试引向真实接口永不返回的形状（见 tests/w9202-provider-effort-defaults.test.ts）。
    //   · 新建模型行的三片来自 modelrow.ts 的 addModelRow（它直接 addChip 三档），
    //     与「回填」是两条独立路径 —— 不是同一个默认值。
    // 想恢复「缺省 = 三片全选」必须改后端契约（保留 absent），见 results/W9202-修复.md。
    r.efforts.set(m.reasoning_efforts);
    // W1536：能力位回填。undefined（providers.json 里没有这个键）= 乐观默认态，
    // 组件会显示默认勾选并打上 is-default 标记；显式数组 = 用户配置态。
    r.inputModalities.set(m.input_modalities);
    r.outputModalities.set(m.output_modalities);
    if (m.context_window != null) r.ctx.value = String(m.context_window);
    // W258 任务 2：max_output_tokens（最大输出 tokens）不回填 —— 留空即可，
    // 留空保存即写 null（后端 numOrNull），这是期望行为。
  }

  const addM = el('button', 'btn-mini', t('settings.providers.addModel')) as HTMLButtonElement;
  addM.type = 'button';
  addM.addEventListener('click', () => addModelRow(e));
  root.appendChild(addM);

  // ---- 操作 ----
  const actions = el('div', 'modal-card-actions');
  const cancel = el('button', 'btn btn-soft', t('settings.action.cancel')) as HTMLButtonElement;
  cancel.type = 'button';
  const save = el('button', 'btn btn-accent', t('settings.action.save')) as HTMLButtonElement;
  save.type = 'button';

  testBtn.addEventListener('click', () => {
    status.className = 'prov-editor-status';
    status.textContent = t('settings.providers.testing');
    void api
      .testProvider(buildPayload(e))
      .then((r) => {
        if (r.ok === false || (r.ok === undefined && r.error)) {
          status.className = 'prov-editor-status err';
          status.textContent = t('settings.providers.testFailed', { reason: userErrorText(r.error, t('settings.common.checkUrlKey')) });
          return;
        }
        status.className = 'prov-editor-status ok';
        status.textContent = t('settings.providers.testOk', { ms: r.latency_ms ?? '—', n: r.model_count ?? '—' });
      })
      .catch((err: unknown) => {
        status.className = 'prov-editor-status err';
        status.textContent = t('settings.providers.testFailed', { reason: fmtErr(err) });
      });
  });

  // 铁律 3：fetch 竞态守卫 —— 连点「获取模型」时，晚到的旧响应直接丢弃
  let fetchSeq = 0;
  fetchBtn.addEventListener('click', () => {
    const seq = ++fetchSeq;
    // W9202：必须用**身份**（originalId），不能用显示名。name 字段装的是 p.name，
    // 而后端 `POST /api/providers/{id}/models/fetch` 用路径参数去 store.find(id)
    // （handlers/providers.ts）。name 与 id 不同的 provider（schema 明说 name 只是
    // display name）此前会先保存成功、紧接着 404 unknown provider。
    // 与 buildPayload 的身份口径（e.originalId ?? name）保持一致。
    const id = e.originalId ?? name.value.trim();
    if (!id) {
      status.className = 'prov-editor-status err';
      status.textContent = t('settings.providers.needId');
      return;
    }
    status.className = 'prov-editor-status';
    // F4-01：「获取模型」是**发现型**动作，不是保存型动作。
    //   旧实现无条件 `saveProvider(buildPayload(e))` 把整张表单写盘，于是「用户没点
    //   保存、甚至 fetch 随后失败」，半成品配置（name/备注/地址/Key/模型）也**已经生效**，
    //   而列表行仍显示旧值（fetch 路径从不调 hooks.onSaved）——落盘与显示不一致，用户
    //   无从察觉。真机复现见 results/audit3-r2/F4/probeG.mjs。
    //   后端 `POST /api/providers/{id}/models/fetch`（handlers/providers.ts:112）只
    //   `store.find(id)` 读既有行，**不需要**先保存 ⇒ 编辑既有 provider 时直接 fetch。
    //   只有**新建**时 store 里还没有这一行，fetch 必然 404 unknown provider —— 那时
    //   才落一行，且只落探测必需的字段（见 buildProbeRow）；模型清单仍以表单为准。
    //   两条路径都**不调 onSaved**：真正的保存由用户点「保存」完成。
    // F4-04：预保存那一行用的是 buildProbeRow（models: []），半填模型行不会被它带走，
    // 但用户此刻填的显示名若就此丢掉仍是无声失败 —— 同样先拦下来。
    const half = halfFilledRow(e);
    if (half !== null) {
      status.className = 'prov-editor-status err';
      status.textContent = t('settings.providers.modelIdRequired', { name: half });
      return;
    }
    const known = e.originalId !== undefined;
    status.className = 'prov-editor-status';
    status.textContent = known
      ? t('settings.providers.fetching')
      : t('settings.providers.savingAndFetching');
    // F4-03：预保存（仅新建）也要**判结果**，不能把 resolve 当成成功。
    //   `requestJson` 对 4xx/5xx 抛 ApiError（api.ts:128），但 200 + {ok:false}
    //   不会抛 —— 那是 ClearResp 契约的合法形状（types/batch.ts 的 OkResp）。
    //   旧代码 `.then(() => fetchProviderModels(id))` 无视回执，于是保存被拒也照样
    //   继续拉模型，用户拿到的是**基于旧配置**的清单，却以为保存成功了。
    //   与保存按钮共用同一个判定（见 checkSaved），两条路径的口径从此一致。
    const begin = known ? Promise.resolve(null) : api.saveProvider(buildProbeRow(e)).then(checkSaved);
    void begin.then(() => api.fetchProviderModels(id))
      .then((r) => {
        if (seq !== fetchSeq) return; // 旧响应：丢弃，不覆盖新状态
        if (r.ok === false || (r.ok === undefined && r.error)) {
          status.className = 'prov-editor-status err';
          status.textContent = t('settings.providers.fetchFailed', { reason: userErrorText(r.error, t('settings.common.checkUrlKey')) });
          return;
        }
        // W258 任务 4：fetch 结果只缓存在局部变量（got），不自动写入表单
        const got = r.models ?? [];
        if (!got.length) {
          status.className = 'prov-editor-status';
          status.textContent = t('settings.providers.noModelsFetched');
          return;
        }
        const existing = new Set(e.rows.map((x) => x.id.value.trim()).filter(Boolean));
        status.className = 'prov-editor-status ok';
        status.textContent = t('settings.providers.fetched', { n: got.length });
        // 二级选择窗：确认后才 addModelRow（已存在的跳过不重复加）
        openModelPicker(
          got.map((m) => ({ id: m.id, existing: existing.has(m.id) })),
          (picked) => {
            const fresh = picked.filter((mid) => !e.rows.some((x) => x.id.value.trim() === mid));
            for (const mid of fresh) addModelRow(e, mid, mid);
            status.className = 'prov-editor-status ok';
            status.textContent = fresh.length
              ? t('settings.providers.added', { n: fresh.length, total: got.length })
              : t('settings.providers.noneSelected', { n: got.length });
          },
        );
      })
      .catch((err: unknown) => {
        if (seq !== fetchSeq) return; // 旧响应：丢弃
        status.className = 'prov-editor-status err';
        status.textContent = t('settings.providers.fetchFailed', { reason: fmtErr(err) });
      });
  });

  save.addEventListener('click', () => {
    const half = halfFilledRow(e);
    if (half !== null) {
      // F4-04：半填行不静默消失 —— 点保存时说清是哪一行缺 id。
      status.className = 'prov-editor-status err';
      status.textContent = t('settings.providers.modelIdRequired', { name: half });
      return;
    }
    const payload = buildPayload(e);
    if (!payload.id) {
      status.className = 'prov-editor-status err';
      status.textContent = t('settings.providers.idRequired');
      return;
    }
    status.className = 'prov-editor-status';
    status.textContent = t('settings.config.saving');
    save.disabled = true;
    void api
      .saveProvider(payload)
      .then(checkSaved)
      .then((r) => {
        void r; // 判定已在 checkSaved 里做完（被拒则抛出，交给 .catch 渲染）
        save.disabled = false;
        status.className = 'prov-editor-status ok';
        status.textContent = t('settings.config.saved');
        hooks.onSaved(payload);
      })
      .catch((err: unknown) => {
        status.className = 'prov-editor-status err';
        status.textContent = t('settings.providers.saveFailed', { reason: fmtErr(err) });
        save.disabled = false;
      });
  });

  cancel.addEventListener('click', () => hooks.onCancel());
  actions.appendChild(cancel);
  actions.appendChild(save);
  root.appendChild(actions);

  return e;
}
