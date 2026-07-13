import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchProvider } from '../search/searxng.js';
import { timeRangeValues } from '../search/searxng.js';
import { fetchPageAsMarkdown } from '../fetch/http-fetch.js';
import { logger } from '../utils/logger.js';

export const searchAndFetchInput = {
  query: z.string().min(1).describe('搜索关键词'),
  fetchCount: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('获取前 N 个搜索结果的页面正文，默认 3'),
  searchMaxResults: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe('搜索结果总数，默认 10'),
  timeRange: z
    .enum(timeRangeValues as [string, ...string[]])
    .optional()
    .describe('时间范围过滤：day / month / year'),
  language: z.string().optional().describe('搜索语言偏好，默认 zh-CN'),
};

export const searchAndFetchDescription = `搜索关键词并自动获取前几个结果的页面正文，一次调用完成「搜索 + 获取」。

- 先搜索获取结果列表，再并行抓取前 N 个页面的 Markdown 正文
- 单个页面获取失败不影响其他结果（失败项会标注原因）
- 适合需要快速获取多个来源内容的场景

输出包含每个结果的标题、URL、摘要，以及成功获取的页面正文。`;

export function registerSearchAndFetch(server: McpServer): void {
  server.registerTool(
    'web_search_and_fetch',
    { description: searchAndFetchDescription, inputSchema: searchAndFetchInput },
    async ({ query, fetchCount = 3, searchMaxResults = 10, timeRange, language }) => {
      // 1. 搜索
      let results;
      try {
        results = await searchProvider.search(query, {
          maxResults: searchMaxResults,
          timeRange: timeRange as 'day' | 'month' | 'year' | undefined,
          language,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `搜索失败: ${message}` }],
        };
      }

      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: `未找到与「${query}」相关的结果。` }],
        };
      }

      // 2. 取前 fetchCount 个结果，并行获取正文
      const targets = results.slice(0, fetchCount);
      const fetchResults = await Promise.allSettled(
        targets.map((r) => fetchPageAsMarkdown(r.url)),
      );

      // 3. 合并输出
      const sections: string[] = [];
      for (let i = 0; i < targets.length; i++) {
        const r = targets[i];
        const fr = fetchResults[i];
        const header = `## ${i + 1}. ${r.title}\nURL: ${r.url}\n摘要: ${r.snippet}`;

        if (fr.status === 'fulfilled') {
          // 截取正文摘要（避免单条过长，整篇正文已有 100KB 截断）
          const body = fr.value.slice(0, 8000);
          sections.push(`${header}\n\n### 正文\n${body}`);
        } else {
          const reason = fr.reason instanceof Error ? fr.reason.message : String(fr.reason);
          logger.warn({ url: r.url, reason }, 'search_and_fetch 单页获取失败');
          sections.push(`${header}\n\n### 正文获取失败\n${reason}`);
        }
      }

      const summary = `搜索「${query}」找到 ${results.length} 条结果，已获取前 ${targets.length} 条正文：\n\n${sections.join('\n\n---\n\n')}`;

      return { content: [{ type: 'text', text: summary }] };
    },
  );
}
