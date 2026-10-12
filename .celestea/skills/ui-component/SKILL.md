---
name: ui-component
description: Use this skill whenever you add or restructure a UI region in apps/web (a panel, a statusstrip cell, a settings pane, a list section). It gives the standard recipe — store / wire / panel — plus the reactive primitives to use, the front-end iron rules that still apply, and the checklist to run before calling it done. Load it before writing new UI code.
license: MIT
metadata:
  scope: frontend
  authority: apps/web/FRONTEND-RULES.md
---

# 新增一个 UI 区域 · 标准配方（apps/web）

> 本 skill 是**操作面**；权威在 `apps/web/FRONTEND-RULES.md`（前端 11 条铁律）与
> `docs/ARCHITECTURE.md`。冲突以它们为准。
> 目的：把「新增面板」从"每次重新发明连线"变成"照抄三件套"。

## 0. 一句话

**状态进 `store.ts`，连线进 `wire.ts`，DOM 进 `panel.ts`。**
三件套之外不写业务；连线不手写「谁变了通知谁」——用 `reactive/` 的 signal 自动追踪。

## 1. 目录形状（照 `ui/taskpanel/` 抄）

```
apps/web/src/ui/<区域名>/
  index.ts     公开面（只导出 mount/dispose 之类的把手）
  store.ts     状态：signal 定义 + 派生(computed) + 动作(写状态的函数)
  panel.ts     渲染：离屏构建 + 单次替换（纯 DOM，不订阅、不发请求）
  wire.ts      连线：effect(() => …) 把状态接到 panel 的更新函数上；返回 dispose
  <区域>.test.ts  单测（纯逻辑优先；DOM 用 jsdom）
```

## 2. 三件套各写什么

### store.ts — 只放状态与动作，不碰 DOM

```ts
import { signal, computed } from '../../reactive';

const [items, setItems] = ... // 见下：signal 的用法
export const itemCount = computed(() => items.get().length);

export function upsertItem(row: Row): void {
  items.set(...);            // 一次动作里改多个信号 → 用 batch()
}
```

### panel.ts — 只做渲染，**不订阅状态**

```ts
export function renderItems(root: HTMLElement, rows: Row[]): void {
  const off = document.createElement('div');
  for (const r of rows) off.appendChild(buildRow(r));   // 离屏构建
  root.replaceChildren(...off.childNodes);              // 单次替换（铁律 1）
}
```

### wire.ts — 唯一允许「状态 → DOM」的地方

```ts
import { effect } from '../../reactive';

export function wireItems(root: HTMLElement): () => void {
  return effect(() => {
    renderItems(root, items.get());     // 依赖自动收集：items 变了才会重跑
  });
}
```

## 3. 用 signal 的规矩

| 要做 | 怎么做 |
|---|---|
| 一次动作改多个信号 | 包在 `batch(() => { … })` 里 —— 否则会跑多次重排 |
| 派生值（计数、格式化结果） | 用 `computed(() => …)`，**不要**在 effect 里手算 |
| 注销 | `effect` 返回 dispose；区域卸载时必须调用（对齐 registry 缝的 `register → dispose`） |
| 写回自己依赖的信号 | **禁止**（会触发自触发保护并 warn）。要改就改成单向：动作 → 状态 → 渲染 |

**不要**引入 React/Preact/Vue/Solid：它们靠全树 diff，与本仓「精确更新」取向相反，
且实测在流式/长列表场景慢 1~2 个数量级（见 2026-10 的 benchmark）。

## 4. 铁律不因用了 signal 而失效

1. **禁「先清空后加载」**：仍走离屏构建 + `replaceChildren` 单次替换。
2. **切换防竞态**：`seq` 递增守卫照写（signal 不解决竞态）。
3. **异步更新不得移动视口**：流式追加后滚动位置照旧守（见 `ui/messages/scroll.ts`）。
4. **动画尊重 `prefers-reduced-motion`**：唯一真源 `ui/viewport.ts`。
5. **长内容 DOM 裁剪要同时释放堆引用**（见 `ui/messages/dom-cap.ts`）。
6. **模块体积**：单文件 ≤450 行（`check-module-size.mjs`，棘轮只降不升）。

## 5. 完成前自查

- [ ] 三件套职责没有互相越界（panel 不订阅、store 不碰 DOM、wire 不写业务）
- [ ] 所有 `effect` 的 dispose 都被调用（区域卸载无泄漏）
- [ ] 多信号更新处都用了 `batch`
- [ ] `pnpm --dir apps/web run check` 全绿（含 UI 文案 / scope-hash / 模块体积 8 关）
- [ ] 改的是 UI → 先 `node scripts/build-webdist.mjs` 再刷新页面（否则看的是旧包）
- [ ] 新行为有测试；建议做变异负控制（改坏应当变红 —— 见 `AGENT.md` §1 第 2 条，**建议项**）
