/**
 * OpenAI 兼容协议适配器（/chat/completions）。
 *
 * 适用于 DeepSeek、OpenAI、OpenRouter、ollama 等所有 OpenAI 兼容接口。
 *
 * 精简自 duet/server/src/ai/providers/openai.ts：
 * - 去掉流式 chatCompletion（MCP 工具不需要流式）
 * - 去掉 reasoning_content / onReasoning 回调
 * - usage 简化为 promptTokens / completionTokens 两个数字
 */
import { trimBaseUrl, readErrorBody, AiError } from './shared.js';
import type { ChatOpts, ChatResult, ProviderAdapter, ChatMessage } from './types.js';

/** OpenAI 非流式响应 */
interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
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
    usage: {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
    },
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
