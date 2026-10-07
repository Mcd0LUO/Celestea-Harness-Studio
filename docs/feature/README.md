# 特性文档索引（`docs/feature/`）

> 状态：**当前**。本目录放**特性级**文档；每篇一个主题，文件名就是主题名。
>
> **写作口径**：只写**当前是什么**与**决定了什么**；过程叙事、编号与日期交给 git 历史（见 [`AGENT.md`](../AGENT.md) §7）。
> **目录名不表达状态** —— 状态写在每篇的状态行里（`暂缓` 是状态，不是名字）。

## 本目录

| 文档 | 状态 | 一句话 |
|---|---|---|
| [`desktop-packaging.md`](./desktop-packaging.md) | 决定（暂缓） | 桌面端打包：评估外部 PR #5 后**暂缓**，附实测数据与 4 条理由 |
| [`display-components.md`](./display-components.md) | 设计（**P0 已实现**） | 可选显示组件：把「渲染后增强」与「markdown 扩展」变成显示插件 |
| [`multimodal-attachments/`](./multimodal-attachments/README.md) | 设计（已实现 P0） | 多模态附件（分册）：图片/文本附件的三入口、能力位与降级 |
| [`computer-use/`](./computer-use/README.md) | 已实现（M1+M2+M2-B2） | 桌面操控（分册）：13 工具、分级闸门、观察租约、自编译 Rust helper |

分册各页：[`01-evidence.md`](./multimodal-attachments/01-evidence.md) · 
[`02-design.md`](./multimodal-attachments/02-design.md) · 
[`03-frontend.md`](./multimodal-attachments/03-frontend.md) · 
[`04-appendix.md`](./multimodal-attachments/04-appendix.md)

computer-use 分册各页：[`01-usage.md`](./computer-use/01-usage.md) · 
[`02-design.md`](./computer-use/02-design.md)

---

历史文档（调研 / 迁移 / 退役）在 [`../archive/`](../archive/)。
