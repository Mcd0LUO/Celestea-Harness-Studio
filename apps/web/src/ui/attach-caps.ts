// ============================================================================
// ui/attach-caps.ts — W9229：附件能力位（部署级 + 逐模型）与降级文案（纯状态，零 DOM）
// ----------------------------------------------------------------------------
// 从 ui/attachments.ts 拆出（模块体积门禁：本轮给它加了生命周期修复，不能再往 450 行
// 上沿挤）。**纯搬家**：判定、缓存失效、降级文案逐字未变，只是换了个文件住。
// 调用方（inputbar / downgrade / chat）仍从 ui/attachments.ts 拿同一组名字。
// ============================================================================
import { api } from '../api';
import { t } from '../i18n';
import { activePane } from './viewctx';


/** 上游降级帧的 reason 取值（设计 §7.6）。 */
const DOWNGRADE_REASON = 'IMAGE_UNSUPPORTED';

let deployMultimodal = false;
let configModel = '';
let allModels: string[] = [];
const modalities = new Map<string, string[]>();
let capsLoaded = false;
let inflight: Promise<void> | null = null;

/** R3 W838-F4：配置/模型已变 → 作废缓存，让下一次 loadAttachmentCapabilities 真重拉。 */
export function invalidateAttachmentCapabilities(): void {
  capsLoaded = false;
  inflight = null;
}

/** 拉一次能力位（health / config / providers）；失败一律按「不可用 + 乐观放行」降级。 */
export function loadAttachmentCapabilities(): Promise<void> {
  if (capsLoaded) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const h = await api.health();
      deployMultimodal = h.capabilities?.multimodal === true;
    } catch {
      deployMultimodal = false;
    }
    try {
      const c = await api.config();
      configModel = c.model ?? '';
    } catch {
      /* 旧服务：当前模型未知 */
    }
    try {
      const p = await api.providers();
      const ids: string[] = [];
      // W862：同一个 id 会在多个 provider 下重复出现（Celestea 网关 / 基元各一条
      // deepseek-flash），降级提示的「可切换到」清单因此出现过重复项。清单按 id
      // **去重并保留首次出现顺序**；能力位写入仍发生在每一次出现上，后出现的同 id
      // provider 照旧覆盖 modalities（既有语义不变，不引入能力位回退）。
      const seen = new Set<string>();
      for (const prov of p.providers ?? []) {
        for (const m of prov.models ?? []) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            ids.push(m.id);
          }
          if (m.input_modalities) modalities.set(m.id, m.input_modalities);
        }
      }
      allModels = ids;
    } catch {
      /* 旧服务：清单缺失 → 全乐观 */
    }
    capsLoaded = true;
  })();
  return inflight;
}

export function attachmentsEnabled(): boolean {
  return deployMultimodal;
}

/** 当前模型：优先会话级覆盖，其次全局配置。 */
export function currentModel(): string {
  const m = activePane()?.model;
  return typeof m === 'string' && m !== '' ? m : configModel;
}

/** 逐模型能力位：缺省 = 乐观支持；只有显式配置的列表才参与判定。 */
export function modelAllowsImages(model: string): boolean {
  if (model === '') return true;
  const list = modalities.get(model);
  return list === undefined ? true : list.includes('image');
}

/** 入口被禁用的可执行原因（'' = 可用）。 */
export function imageEntryDisabledReason(): string {
  if (!deployMultimodal) return t('chat.attach.imageEntryDisabled');
  const model = currentModel();
  if (model !== '' && !modelAllowsImages(model)) {
    return t('chat.attach.modelNoImages', { model });
  }
  return '';
}

/** 可作为降级建议的模型清单（未显式排除图像的前几个）。 */
export function imageCapableModels(): string[] {
  return allModels.filter((id) => modelAllowsImages(id)).slice(0, 6);
}


// ---- 上游「图像不支持」降级提示（设计 §7.6） ------------------------------------

export function isImageDowngrade(p: { reason?: unknown; message?: unknown }): boolean {
  if (p.reason === DOWNGRADE_REASON) return true;
  // 匹配**服务端原文**的防御性回退（旧服务），不是 UI 文案：
  return typeof p.message === 'string' && p.message.indexOf('拒绝了图像输入') >= 0; // copy-gate-allow
}

/** 信息块文案：服务端定稿 message + hint，再补一条可切换模型清单。 */
export function downgradeNotice(p: { message?: unknown; hint?: unknown; model?: unknown }): string {
  const msg = typeof p.message === 'string' && p.message !== '' ? p.message : t('chat.attach.downgradeDefault');
  const hint = typeof p.hint === 'string' ? p.hint : '';
  // D2：排除本次肇事模型 —— 能力位是乐观默认，刚被上游 400 拒绝的模型本会出现在清单里。
  const debris = typeof p.model === 'string' ? p.model : '';
  const models = imageCapableModels().filter((id) => id !== debris);
  const suggest = models.length > 0 ? t('chat.attach.suggestSwitch', { models: models.join(t('chat.question.answerSep')) }) : '';
  return [msg, hint, suggest].filter((s) => s !== '').join('\n');
}

