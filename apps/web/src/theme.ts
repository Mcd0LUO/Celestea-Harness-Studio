// ============================================================================
// Theme / color-card switching: <html data-theme> single attribute.
// 第 26 轮（W256）：仅保留单主题 mono（黑白 ins 风）；夜航（night）主题已删除。
// ============================================================================

import { t } from './i18n';

export interface ThemeDef {
  id: string;
  label: string;
  hint: string;
}

/** 主题定义（函数：文案走 t()，语言切换后必须跟着变）。 */
export function themes(): readonly ThemeDef[] {
  return [
    { id: 'mono', label: t('theme.mono.label'), hint: t('theme.mono.hint') },
    // W12：深色主题 —— 只覆盖 static/alias token（见 styles/tokens.css），组件零改动。
    { id: 'dark', label: t('theme.dark.label'), hint: t('theme.dark.hint') },
    // W1535：Claude Code 风格 —— Anthropic 官方品牌色（暖米白 / 陶土橙 / 暖灰）。
    // 同样只覆盖 static/alias token（见 styles/theme-claude.css），组件零改动；
    // 该主题自带深浅两套，深色由系统 prefers-color-scheme 选择（仍是单一 data-theme id）。
    { id: 'claude', label: t('theme.claude.label'), hint: t('theme.claude.hint') },
  ];
}

const STORAGE_KEY = 'celestea-studio.theme';

/*
 * F4-05：无 DOM 环境（node / worker / SSR）下本模块曾直接抛 `ReferenceError:
 * document is not defined`。实测（tests/w9301-theme-nodom.test.ts，未开 jsdom 的
 * 默认 node 环境）：`currentTheme()` 与 `applyTheme()` 都会炸。
 *
 * 为什么这不只是洁癖：vitest 的默认 environment 是 **node**（vitest.config.ts 没有
 * 全局 `environment: 'jsdom'`，要 DOM 靠每个文件的 `@vitest-environment jsdom` 头），
 * 所以任何未加该头、又 import 了本模块的测试都会在 import 期的**渲染期**崩掉。
 * 仓内先例同源：i18n/index.ts 的 `typeof navigator`、plugins/store.ts 的
 * `typeof localStorage`、permissions/store.ts 的 `typeof window`。
 *
 * 读侧回落成 'mono'（与 README 记录的默认一致），写侧在无 DOM 时**不假装成功**：
 * 写不进 DOM 就等于没写，但 localStorage 仍尽力写（node/worker 下可能可用），
 * 于是「记住偏好」这条能力不被牵连。
 */
function themeEl(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

export function currentTheme(): string {
  return themeEl()?.dataset.theme || 'mono';
}

export function applyTheme(id: string): void {
  const root = themeEl();
  if (root !== null) root.dataset.theme = id;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* storage unavailable — ignore */
  }
}

/** Apply the persisted (or default) theme; returns the applied id.
 *  旧版 localStorage 里存过已删除主题 id 时（THEMES.some 不命中）自动回落到 mono。
 *  F4-05：getItem 的 `try` 过去顺带挡住了无 DOM 环境的 ReferenceError，但那靠的是
 *  「ReferenceError 恰好是 Error」这条巧合；这里显式判 typeof，与 applyTheme 同一口径。 */
export function initTheme(defaultId = 'mono'): string {
  let id = defaultId;
  try {
    const saved = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
    if (saved && themes().some((x) => x.id === saved)) id = saved;
  } catch {
    /* ignore */
  }
  applyTheme(id);
  return id;
}

/** Wire the topbar switcher：单主题下点击 = no-op（不循环、不闪动），
 *  按钮保留显示当前主题「黑白」。 */
export function setupThemeSwitcher(button: HTMLElement): void {
  const render = (): void => {
    const cur = currentTheme();
    const theme = themes().find((x) => x.id === cur) ?? themes()[0]!;
    button.textContent = theme.label;
    button.title = t('theme.title', { hint: theme.hint, suffix: themes().length > 1 ? t('theme.clickToSwitch') : t('theme.onlyTheme') });
  };
  render();
  if (themes().length < 2) {
    // 仅剩单主题：不注册点击行为，避免无意义的重绘/闪动
    button.setAttribute('aria-disabled', 'true');
    return;
  }
  button.addEventListener('click', () => {
    const idx = themes().findIndex((x) => x.id === currentTheme());
    const next = themes()[(idx + 1) % themes().length]!;
    applyTheme(next.id);
    render();
  });
}
