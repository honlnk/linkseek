/**
 * OpenAI 兼容协议适配器（/chat/completions）。
 *
 * 适用于 DeepSeek、OpenAI、OpenRouter、ollama 等所有 OpenAI 兼容接口。
 *
 * 精简自 duet/server/src/ai/providers/openai.ts：
 * - 去掉流式 chatCompletion（MCP 工具不需要流式）
 * - 去掉 reasoning_content / onReasoning 回调
 */
import { trimBaseUrl, readErrorBody, AiError, EMPTY_USAGE } from './shared.js';
import type { ChatOpts, ChatResult, ProviderAdapter, ChatMessage, NormalizedUsage } from './types.js';

/** OpenAI usage（DeepSeek 系额外带 prompt_cache_*；OpenAI 官方走 prompt_tokens_details.cached_tokens） */
interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  // DeepSeek / 部分中转原生提供的缓存拆分字段
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_cache_write_tokens?: number;
  // OpenAI 官方的缓存命中（嵌套在 details 里）
  prompt_tokens_details?: { cached_tokens?: number };
}

/** OpenAI 非流式响应 */
interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  usage?: OpenAIUsage;
}

/**
 * 归一化 usage：
 * - DeepSeek 系原生带 prompt_cache_hit/miss_tokens，直接透传；
 * - OpenAI 官方只给 prompt_tokens_details.cached_tokens，miss = max(0, prompt - cached)；
 * - 缓存写入 OpenAI 不提供，恒为 0。
 */
function normalizeUsage(u: OpenAIUsage | undefined): NormalizedUsage {
  if (!u) return { ...EMPTY_USAGE };
  const prompt = u.prompt_tokens ?? 0;
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  // 优先用上游原生拆分（DeepSeek）；否则由 cached_tokens 反推 miss
  const hit = u.prompt_cache_hit_tokens ?? cached;
  const miss =
    u.prompt_cache_miss_tokens ?? (cached > 0 ? Math.max(0, prompt - cached) : prompt);
  return {
    promptTokens: prompt,
    completionTokens: u.completion_tokens ?? 0,
    cacheHitTokens: hit,
    cacheMissTokens: miss,
    cacheWriteTokens: u.prompt_cache_write_tokens ?? 0,
  };
}

/** 非流式聊天 */
async function chatComplete(opts: ChatOpts): Promise<ChatResult> {
  const { messages, conn, temperature = 0.3, maxTokens = 2000, timeout = 30_000 } = opts;
  const url = `${trimBaseUrl(conn.baseUrl)}/chat/completions`;
  const body = {
    model: conn.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${conn.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });

  if (!resp.ok) {
    const text = await readErrorBody(resp);
    throw new AiError(`OpenAI API ${resp.status}: ${text}`, resp.status);
  }

  const json = (await resp.json()) as ChatCompletionResponse;
  return {
    content: json.choices?.[0]?.message?.content || '',
    usage: normalizeUsage(json.usage),
  };
}

/** 拉取模型列表：GET /models → data[].id */
async function listModels(conn: { baseUrl: string; apiKey: string }): Promise<string[]> {
  const url = `${trimBaseUrl(conn.baseUrl)}/models`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${conn.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const text = await readErrorBody(resp);
    throw new AiError(`拉取模型列表失败 ${resp.status}: ${text}`, resp.status);
  }
  const json = (await resp.json()) as { data?: Array<{ id?: string }> };
  const ids = Array.isArray(json.data)
    ? json.data.map((m) => m.id).filter((id): id is string => typeof id === 'string')
    : [];
  return [...new Set(ids)].sort();
}

export const openaiAdapter: ProviderAdapter = { chatComplete, listModels };

// 导入 ChatMessage 仅为类型完整性（openai 协议直接用 messages 数组，不需要转换）
export type { ChatMessage };
