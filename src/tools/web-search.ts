import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchProvider } from '../search/searxng.js';
import { timeRangeValues } from '../search/searxng.js';

export const webSearchInput = {
  query: z.string().min(1).describe('搜索关键词'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe('最大返回结果数，默认 10'),
  timeRange: z
    .enum(timeRangeValues as [string, ...string[]])
    .optional()
    .describe('时间范围过滤：day（一天内）/ month（一月内）/ year（一年内）'),
  language: z
    .string()
    .optional()
    .describe('搜索语言偏好，如 zh-CN、en、all。默认 zh-CN'),
};

export const webSearchDescription = `联网搜索，返回关键词匹配的网页列表。

- 基于自托管 SearXNG 元搜索引擎，聚合多个搜索源
- 返回结构化结果：每条含标题、URL、摘要
- 可按时间范围、语言过滤`;

export function registerWebSearch(server: McpServer): void {
  server.registerTool(
    'web_search',
    { description: webSearchDescription, inputSchema: webSearchInput },
    async ({ query, maxResults, timeRange, language }) => {
      try {
        const results = await searchProvider.search(query, {
          maxResults,
          timeRange: timeRange as 'day' | 'month' | 'year' | undefined,
          language,
        });

        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: `未找到与「${query}」相关的结果。` }],
          };
        }

        // 格式化为 AI 友好的文本
        const lines = results.map(
          (r, i) =>
            `## ${i + 1}. ${r.title}\nURL: ${r.url}\n${r.snippet}`,
        );
        const text = `找到 ${results.length} 条结果：\n\n${lines.join('\n\n')}`;

        return { content: [{ type: 'text', text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `搜索失败: ${message}` }],
        };
      }
    },
  );
}
