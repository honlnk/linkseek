/**
 * LLM 协议适配器统一接口。
 *
 * 从 duet 项目精简移植：去掉流式（chatCompletion）、reasoning 回调，
 * 保留 usage 成本归一化（NormalizedUsage）——只保留非流式 chatComplete + listModels。
 *
 * 各协议（OpenAI / Responses / Anthropic / Gemini）的适配器实现此接口，
 * 上层调用方通过 getAdapter(protocol) 拿到对应适配器，无需关心协议差异。
 */

/** 支持的协议类型 */
export type Protocol = 'openai' | 'openai-responses' | 'anthropic' | 'gemini';

/** LLM 消息（OpenAI 格式为基准） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 连接配置（从 LlmProvider 数据库记录映射而来） */
export interface ConnectionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: Protocol;
}

/** 调用参数 */
export interface ChatOpts {
  messages: ChatMessage[];
  conn: ConnectionConfig;
  temperature?: number;
  maxTokens?: number;
  /** 超时毫秒，默认 30s */
  timeout?: number;
}

/**
 * 归一化后的 token 用量（对齐 duet 的 NormalizedUsage，camelCase 风格）。
 * 各协议适配器把自身 usage 字段映射到此结构，使上层成本计算无需感知协议差异：
 * - OpenAI: prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens
 * - Responses: input_tokens / output_tokens / input_tokens_details.cached_tokens
 * - Anthropic: input_tokens(含缓存) / output_tokens / cache_read / cache_creation
 * - Gemini: promptTokenCount / candidatesTokenCount / cachedContentTokenCount
 */
export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  /** 缓存命中 token（按低价计费） */
  cacheHitTokens: number;
  /** 缓存未命中 token（按输入原价计费） */
  cacheMissTokens: number;
  /** 缓存写入 token（Anthropic 等少数模型按额外价计费） */
  cacheWriteTokens: number;
}

/** 调用结果 */
export interface ChatResult {
  content: string;
  usage: NormalizedUsage;
}

/** 协议适配器接口 */
export interface ProviderAdapter {
  /** 非流式聊天（QA / 摘要等场景用） */
  chatComplete(opts: ChatOpts): Promise<ChatResult>;
  /** 拉取该 Provider 可用的模型列表 */
  listModels(conn: Omit<ConnectionConfig, 'model'>): Promise<string[]>;
}
