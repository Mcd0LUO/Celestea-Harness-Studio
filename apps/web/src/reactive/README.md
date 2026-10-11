# reactive/ — 细粒度响应式原语

> 零依赖、零 reconcile。目录里只有 `signal.ts`（实现）+ `signal.test.ts`（测试），
> 公开面收口在 `index.ts`。

## 它解决什么

本仓前端的更新方式是「**状态变化 → 手动调用纯写入函数改对应 DOM**」，性能最好，但
**连线是手工的**：新增一个字段，就要在 wire 里补一行「谁变了通知谁」；漏一处，表现就是
「界面不更新」。

框架（React/Preact/Solid）提供的开发体验核心只有两条：**① 自动追踪依赖；② 依赖变化自动重跑**。
它们的代价来自另外两样东西：**vdom 全树 diff** 与 **运行时体积**。

本模块只搬走前两条，不要后两样。

## 何时用它

| 用它 | 别用它 |
|---|---|
| 模块内的「状态 → DOM」连线（面板字段、状态栏单元格、列表行状态） | 跨模块的事件广播 → 仍走 `core/event-bus.ts` |
| 需要「改一个字段只更新那一处」 | 流式正文热路径（`ui/messages/*`）—— 那里已由 `frame-budget` + `cadence` 精细控制 |
| 已有 store 但 wire 是手工的分发 | 计算密集型渲染（markdown 解析/高亮）—— 那是纯计算，与状态无关 |

## API

```ts
import { signal, computed, effect, batch, untrack, onCleanup } from '../../reactive';

const count = signal(0);                 // 可写
const doubled = computed(() => count.get() * 2);  // 派生（惰性启动）

const dispose = effect(() => {           // 立即跑一次以收集依赖，此后按依赖变化重跑
  el.textContent = String(doubled.get());
  onCleanup(() => { /* 重跑前 / 注销时执行 */ });
});

count.set(1);                            // → 只有依赖它的 effect 被唤醒
batch(() => { count.set(2); other.set(3); });  // 一次动作改多个 → 只重排一次
dispose();                               // 注销（对齐本仓 register → dispose 形状）
```

| 原语 | 要点 |
|---|---|
| `signal(v)` | `get()` 读（在 effect 内 = **声明依赖**）；`peek()` 读但**不**声明依赖；`set()` 同值不触发（`Object.is`）；`readonly()` 给下游只读视图 |
| `computed(fn)` | 惰性：**第一次 `get()` 才建立订阅**；上游变化自动重算并向下游传播 |
| `effect(fn)` | 立即执行一次收集依赖；返回 **dispose**（必须调用，否则泄漏） |
| `batch(fn)` | 把 fn 内所有 `set` 合并成一轮重跑；fn 抛错也会消费队列 |
| `untrack(fn)` | fn 内读多少 signal 都不入依赖 |
| `onCleanup(fn)` | 本 effect **重跑前**与**注销时**各跑一次；只能在 effect 内调用（否则 warn） |

### `get()` 与 `peek()` 的区别是本模块最容易踩的坑

- `get()` —— 「我依赖它，它变了我该重跑」（**默认意图**）；
- `peek()` —— 「我只想看一眼，它变了**别**唤醒我」（日志、一次性判断、快照比对）。

用错 `get()` 会让 effect 依赖上不该依赖的东西，表现为「无关字段变了却导致重画」。

## 四道闸（都有测试 + 变异负控制）

| 闸 | 行为 |
|---|---|
| ① 自触发保护 | 运行中的 effect 再被调度 → 丢弃并 warn，绝不嵌套重入自己 |
| ② 循环深度保护 | effect 链成环时在嵌套到 100 层停住并 warn（不栈溢出）；正常多级更新深度 < 10 |
| ③ 抛错隔离 | 一个 effect 抛错只 warn，不打断同批其它 effect，也不把异常抛回 `set()`（同 `ui/hint/registry.ts` 的既有取舍） |
| ④ 清理钩子 | `onCleanup` 的清理抛错被隔离，不影响后续清理与重跑 |

## 与既有机制的分工（不要混用）

| 层 | 用什么 | 说明 |
|---|---|---|
| 跨模块「谁发生了什么事」 | `core/event-bus.ts` | 广播/守卫/瀑布；signal 不做总线 |
| 模块内「状态 → DOM」 | **本模块** | 只负责最后一段：事件到手之后，这几个节点该怎么跟着变 |
| 渲染后的容器增强 | `ui/enhance/registry.ts` | 渲染管线的挂载点，与状态无关 |
| 悬浮提示的认领 | `ui/hint/registry.ts` | 同上 |

## 落地方式

见 `.celestea/skills/ui-component/SKILL.md` 的「store / wire / panel」三件套：
`store` 放 signal，`wire` 用 `effect` 绑定，`panel` 保持纯渲染（不订阅）。

**已落地的参考实现**：`ui/taskpanel/{store,wire}.ts`（第一个试点）。
