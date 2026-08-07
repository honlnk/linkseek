/**
 * Google Gemini API 适配器（generateContent）。
 *
 * 协议要点：
 * - 端点：/v1beta/models/{model}:generateContent
 * - 鉴权：URL query ?key=
 * - system 消息抽到顶层 systemInstruction
 * - messages 转 contents:[{role, parts:[{text}]}]，assistant→model 映射
 * - temperature / maxTokens 进 generationConfig（maxTokens → maxOutputTokens）
 *
 * 精简自 duet/server/src/ai/providers/gemini.ts。
 */
import { trimBaseUrl, readErrorBody, AiError } from './shared.js';
import type { ChatOpts, ChatResult, ProviderAdapter, ChatMessage } from './types.js';

/** Gemini 非流式响应 */
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

/** 把通用 messages 转成 Gemini 的 contents + systemInstruction */
function toGeminiInput(messages: ChatMessage[]): {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
} {
  const systemParts: string[] = [];
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
    } else {
      // assistant → model，user → user
      const role = m.role === 'assistant' ? 'model' : 'user';
      contents.push({ role, parts: [{ text: m.content }] });
    }
  }
  const result: ReturnType<typeof toGeminiInput> = { contents };
  if (systemParts.length > 0) {
    result.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
  }
  return result;
}

/** 非流式聊天 */
async function chatComplete(opts: ChatOpts): Promise<ChatResult> {
  const { messages, conn, temperature = 0.3, maxTokens = 2000, timeout = 30_000 } = opts;
  const { systemInstruction, contents } = toGeminiInput(messages);
  const base = trimBaseUrl(conn.baseUrl);
  const url = `${base}/v1beta/models/${conn.model}:generateContent?key=${conn.apiKey}`;
  const body: Record<string, unknown> = {
    contents,
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  if (systemInstruction) body.systemInstruction = systemInstruction;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) {
    const text = await readErrorBody(resp);
    throw new AiError(`Gemini API ${resp.status}: ${text}`, resp.status);
  }
  const json = (await resp.json()) as GeminiResponse;
  const parts = json.candidates?.[0]?.content?.parts;
  const content = parts ? parts.filter((p) => p.text).map((p) => p.text!).join('') : '';
  return {
    content,
    usage: {
      promptTokens: json.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

/** 拉取模型列表：GET /v1beta/models → models[].name（去 models/ 前缀） */
async function listModels(conn: { baseUrl: string; apiKey: string }): Promise<string[]> {
  const base = trimBaseUrl(conn.baseUrl);
  const url = `${base}/v1beta/models?key=${conn.apiKey}`;
  const resp = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const text = await readErrorBody(resp);
    throw new AiError(`拉取模型列表失败 ${resp.status}: ${text}`, resp.status);
  }
  const json = (await resp.json()) as { models?: Array<{ name?: string }> };
  const ids = Array.isArray(json.models)
    ? json.models
        .map((m) => m.name ?? '')
        .map((name) => name.replace(/^models\//, ''))
        .filter((id) => id.length > 0)
    : [];
  return [...new Set(ids)].sort();
}

export const geminiAdapter: ProviderAdapter = { chatComplete, listModels };
