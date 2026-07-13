import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWebSearch } from './web-search.js';
import { registerWebFetch } from './web-fetch.js';
import { registerSearchAndFetch } from './search-and-fetch.js';

/**
 * 在 McpServer 上注册所有工具。
 */
export function registerTools(server: McpServer): void {
  registerWebSearch(server);
  registerWebFetch(server);
  registerSearchAndFetch(server);
}
