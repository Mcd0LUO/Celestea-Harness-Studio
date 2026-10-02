// ============================================================================
// types/prompt.ts — 提示词系统族（W245）的线格式，从 types.ts 按域拆出
// （同 ./sse 的棘轮理由，types.ts 原样再导出，调用方零改动）。
// ============================================================================

export interface PromptSection {
  id: string;
  name: string;
  template: string;
  order: number;
  scope: 'builtin' | 'global' | 'workspace';
}

export interface PromptInfo {
  id: string;
  name: string;
  is_default?: boolean;
  /** 段覆盖（编辑弹窗打开时必须回填，否则保存会清掉旧覆盖）。 */
  section_overrides?: Record<string, string>;
  scope: 'global' | 'workspace';
  shadowed?: boolean;
}

export interface PromptsResp {
  ok?: boolean;
  /** 显式 scope（后端固定声明；客户端不再从空值推断）。 */
  scope?: 'global' | 'workspace';
  sections?: PromptSection[];
  prompts?: PromptInfo[];
  default_prompt?: string | null;
  active_prompt?: string | null;
  error?: string;
}

/** POST /api/prompts upsert 载荷（P0-4：不传 workspace=全局）。 */
export interface PromptUpsertReq {
  workspace?: string;
  id: string;
  name: string;
  section_overrides: Record<string, string>;
  is_default?: boolean;
}
