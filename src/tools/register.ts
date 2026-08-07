import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getDefaultProvider } from '../llm/provider-store.js';
import { registerWebSearch } from './web-search.js';
import { registerWebFetch } from './web-fetch.js';
import { registerSearchAndFetch } from './search-and-fetch.js';
import { registerWebFetchRender } from './web-fetch-render.js';
import { registerListModels } from './list-models.js';
import { registerWebFetchAnswer } from './web-fetch-answer.js';
import { registerWebSearchAnswer } from './web-search-answer.js';

/**
 * 在 McpServer 上注册所有工具。
 *
 * - web_fetch_render 依赖 browserless 容器，通过 BROWSER_FETCH_ENABLED 控制
 * - list_models / web_fetch_answer / web_search_answer 依赖 LLM Provider 配置，
 *   仅在数据库中存在 enabled 的默认 Provider 时注册
 */
export async function registerTools(server: McpServer): Promise<void> {
  registerWebSearch(server);
  registerWebFetch(server);
  registerSearchAndFetch(server);

  if (config.BROWSER_FETCH_ENABLED) {
    registerWebFetchRender(server);
  } else {
    logger.info('web_fetch_render 工具已禁用（BROWSER_FETCH_ENABLED=false）');
  }

  // LLM 工具仅在配置了至少一个 enabled 的默认 Provider 时注册
  const hasLlm = await getDefaultProvider();
  if (hasLlm) {
    registerListModels(server);
    registerWebFetchAnswer(server);
    registerWebSearchAnswer(server);
    logger.info({ provider: hasLlm.name }, 'AI 增强工具已注册（list_models / web_fetch_answer / web_search_answer）');
  } else {
    logger.info('AI 增强工具未注册（未配置 enabled 的默认 LLM Provider）');
  }
}
