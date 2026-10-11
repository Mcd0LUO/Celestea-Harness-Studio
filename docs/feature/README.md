# 特性文档索引（`docs/feature/`）

> 状态：**当前**。本目录放**特性级**文档；每篇一个主题，文件名就是主题名。
>
> **写作口径**：只写**当前是什么**与**决定了什么**；过程叙事、编号与日期交给 git 历史（见 [`AGENT.md`](../AGENT.md) §7）。
> **目录名不表达状态** —— 状态写在每篇的状态行里（`暂缓` 是状态，不是名字）。

## 本目录

| 文档 | 状态 | 一句话 |
|---|---|---|
| [`composer-surface.md`](./composer-surface.md) | 设计（**已实现**） | 输入栏与命令面：补全框分组能力、发送前变换缝、输入栏扩展点盘点 |
| [`desktop-packaging.md`](./desktop-packaging.md) | 决定（暂缓） | 桌面端打包：评估外部 PR #5 后**暂缓**，附实测数据与 4 条理由 |
| [`display-components.md`](./display-components.md) | 设计（**P0 已实现**） | 可选显示组件：把「渲染后增强」与「markdown 扩展」变成显示插件 |
| [`mcp-client.md`](./mcp-client.md) | 设计（**P0 已实现**） | MCP 客户端：只做客户端、协议走官方 SDK、动态工具不进冻结契约、每会话一代连接 |
| [`multimodal-attachments/`](./multimodal-attachments/README.md) | 设计（已实现 P0） | 多模态附件（分册）：图片/文本附件的三入口、能力位与降级 |
| [`skill-command.md`](./skill-command.md) | 设计（**已实现**） | 技能显式调用：`/{技能名}` 直呼，host 侧确定性注入正文 |

分册各页：[`01-evidence.md`](./multimodal-attachments/01-evidence.md) · 
[`02-design.md`](./multimodal-attachments/02-design.md) · 
[`03-frontend.md`](./multimodal-attachments/03-frontend.md) · 
[`04-appendix.md`](./multimodal-attachments/04-appendix.md)

---

历史文档（调研 / 迁移 / 退役）在 [`../archive/`](../archive/)。
