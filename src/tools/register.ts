import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { registerWebSearch } from './web-search.js';
import { registerWebFetch } from './web-fetch.js';
import { registerSearchAndFetch } from './search-and-fetch.js';
import { registerWebFetchRender } from './web-fetch-render.js';

/**
 * 在 McpServer 上注册所有工具。
 *
 * web_fetch_render 依赖独立部署的 browser-fetch 微容器，
 * 通过 BROWSER_FETCH_ENABLED 开关控制是否注册（关闭时该工具对 AI 不可见）。
 */
export function registerTools(server: McpServer): void {
  registerWebSearch(server);
  registerWebFetch(server);
  registerSearchAndFetch(server);

  if (config.BROWSER_FETCH_ENABLED) {
    registerWebFetchRender(server);
  } else {
    logger.info('web_fetch_render 工具已禁用（BROWSER_FETCH_ENABLED=false）');
  }
}
