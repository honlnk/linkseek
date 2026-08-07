/**
 * OpenAI Responses API 适配器（/responses）。
 *
 * 与 OpenAI Compatible（/chat/completions）的区别：
 * - 端点是 /responses
 * - system 消息抽到顶层 instructions
 * - body 用 input 而非 messages；max_output_tokens 代替 max_tokens
 * - usage: input_tokens / output_tokens
 *
 * 精简自 duet/server/src/ai/providers/openai-responses.ts。
 */
import { trimBaseUrl, readErrorBody, AiError } from './shared.js';
import type { ChatOpts, ChatResult, ProviderAdapter, ChatMessage } from './types.js';

/** Responses API usage */
interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
}

/** Responses 非流式响应 */
interface ResponsesResponse {
  output_text?: string;
  output?: Array<{
    type: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
  usage?: ResponsesUsage;
}

/** 把 system 抽到 instructions，其余转 input 数组 */
function toResponsesInput(messages: ChatMessage[]): {
  instructions?: string;
  input: Array<{ role: string; content: string }>;
} {
  const systemParts: string[] = [];
  const input: Array<{ role: string; content: string }> = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
    } else {
      input.push({ role: m.role, content: m.content });
    }
  }
  const result: ReturnType<typeof toResponsesInput> = { input };
  if (systemParts.length > 0) result.instructions = systemParts.join('\n\n');
  return result;
}

/** 非流式聊天 */
async function chatComplete(opts: ChatOpts): Promise<ChatResult> {
  const { messages, conn, temperature = 0.3, maxTokens = 2000, timeout = 30_000 } = opts;
  const { instructions, input } = toResponsesInput(messages);
  const url = `${trimBaseUrl(conn.baseUrl)}/responses`;
  const body: Record<string, unknown> = {
    model: conn.model,
    input,
    temperature,
    max_output_tokens: maxTokens,
    stream: false,
  };
  if (instructions) body.instructions = instructions;

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
    throw new AiError(`Responses API ${resp.status}: ${text}`, resp.status);
  }
  const json = (await resp.json()) as ResponsesResponse;
  // 优先用 output_text（SDK 已拼接），否则从 output 数组提取
  let content = json.output_text;
  if (!content && Array.isArray(json.output)) {
    content = json.output
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === 'output_text' && c.text)
      .map((c) => c.text!)
      .join('');
  }
  return {
    content: content ?? '',
    usage: {
      promptTokens: json.usage?.input_tokens ?? 0,
      completionTokens: json.usage?.output_tokens ?? 0,
    },
  };
}

/** 拉取模型列表：与 Compatible 共用 GET /models */
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

export const openaiResponsesAdapter: ProviderAdapter = { chatComplete, listModels };
