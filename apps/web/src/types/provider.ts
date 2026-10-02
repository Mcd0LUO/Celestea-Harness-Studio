// ============================================================================
// types/provider.ts — 模型提供商族（W236）的线格式，从 types.ts 按域拆出
// （同 ./sse 的棘轮理由，types.ts 原样再导出，调用方零改动）。
// ============================================================================

export interface ProviderModelSpec {
  id: string;
  name: string;
  reasoning_efforts?: string[];
  context_window?: number | null;
  max_output_tokens?: number | null;
  /** W804/W805：逐模型能力位（缺省 = 乐观支持图像输入，配置是唯一权威）。 */
  input_modalities?: string[];
  output_modalities?: string[];
}

export interface ProviderInfo {
  id: string;
  name?: string;
  note?: string;
  base_url?: string;
  request_format?: string;
  models?: ProviderModelSpec[];
  is_default?: boolean;
  has_key?: boolean;
}

export interface ProvidersResp {
  ok?: boolean;
  providers?: ProviderInfo[];
  default_model?: string | null;
  error?: string;
}

export interface ProviderTestResp {
  ok?: boolean;
  latency_ms?: number;
  model_count?: number;
  error?: string;
}

export interface ProviderFetchResp {
  ok?: boolean;
  models?: { id: string }[];
  error?: string;
}
