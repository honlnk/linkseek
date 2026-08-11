/**
 * Anthropic Messages API 适配器（/v1/messages）。
 *
 * 适用于 Claude 官方及各种 Claude 中转。
 *
 * 协议要点：
 * - system 消息必须从 messages 抽出，放顶层 `system` 字段
 * - role 只允许 user / assistant（system 不能出现在 messages）
 * - 鉴权用 `x-api-key` + `anthropic-version` 头（非 Bearer）
 * - max_tokens 为必填项
 *
 * 精简自 duet/server/src/ai/providers/anthropic.ts。
 */
import { trimBaseUrl, readErrorBody, AiError, EMPTY_USAGE } from './shared.js';
import type { ChatOpts, ChatResult, ProviderAdapter, ChatMessage, NormalizedUsage } from './types.js';

/** Anthropic usage（input_tokens 含缓存读取/写入，需拆分） */
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Anthropic 非流式响应 */
interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: AnthropicUsage;
}

/**
 * 归一化 usage：input→prompt、output→completion、cache_read→hit、cache_creation→write。
 * Anthropic 的 input_tokens 含全部输入（含缓存命中与写入），故未命中需扣除：
 *   miss = max(0, input - cacheRead - cacheCreate)
 */
function normalizeUsage(u: AnthropicUsage | undefined): NormalizedUsage {
  if (!u) return { ...EMPTY_USAGE };
  const input = u.input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  return {
    promptTokens: input,
    completionTokens: u.output_tokens ?? 0,
    cacheHitTokens: cacheRead,
    cacheMissTokens: Math.max(0, input - cacheRead - cacheCreate),
    cacheWriteTokens: cacheCreate,
  };
}

/** 把通用 messages 拆成 { system, messages }：system 抽到顶层，其余保留 user/assistant */
function splitSystem(messages: ChatMessage[]): { system: string; messages: ChatMessage[] } {
  const systemParts: string[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
    } else {
      rest.push(m);
    }
  }
  return { system: systemParts.join('\n\n'), messages: rest };
}

/** 非流式聊天 */
async function chatComplete(opts: ChatOpts): Promise<ChatResult> {
  const { messages, conn, temperature = 0.3, maxTokens = 2000, timeout = 30_000 } = opts;
  const { system, messages: apiMessages } = splitSystem(messages);
  const url = `${trimBaseUrl(conn.baseUrl)}/v1/messages`;
  const body: Record<string, unknown> = {
    model: conn.model,
    messages: apiMessages,
    max_tokens: maxTokens,
    temperature,
    stream: false,
  };
  if (system) body.system = system;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': conn.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });

  if (!resp.ok) {
    const text = await readErrorBody(resp);
    throw new AiError(`Anthropic API ${resp.status}: ${text}`, resp.status);
  }

  const json = (await resp.json()) as AnthropicResponse;
  // 拼接所有 text 块（content 是数组，可能有多个 text block）
  const content = (json.content || [])
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('');
  return {
    content,
    usage: normalizeUsage(json.usage),
  };
}

/** 拉取模型列表：GET /v1/models → data[].id */
async function listModels(conn: { baseUrl: string; apiKey: string }): Promise<string[]> {
  const url = `${trimBaseUrl(conn.baseUrl)}/v1/models`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'x-api-key': conn.apiKey,
      'anthropic-version': '2023-06-01',
    },
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

export const anthropicAdapter: ProviderAdapter = { chatComplete, listModels };
