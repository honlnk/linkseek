/**
 * 协议适配器工厂。
 *
 * 调用方通过 getAdapter(protocol) 拿到对应适配器，无需关心具体协议。
 */
import type { Protocol } from './types.js';
import type { ProviderAdapter } from './types.js';
import { openaiAdapter } from './openai.js';
import { openaiResponsesAdapter } from './openai-responses.js';
import { anthropicAdapter } from './anthropic.js';
import { geminiAdapter } from './gemini.js';

export { AiError } from './shared.js';
export type { Protocol, ProviderAdapter, ChatOpts, ChatResult, ChatMessage, ConnectionConfig } from './types.js';

/** 按协议类型返回对应适配器 */
export function getAdapter(protocol: Protocol): ProviderAdapter {
  switch (protocol) {
    case 'openai-responses':
      return openaiResponsesAdapter;
    case 'anthropic':
      return anthropicAdapter;
    case 'gemini':
      return geminiAdapter;
    case 'openai':
    default:
      return openaiAdapter;
  }
}
