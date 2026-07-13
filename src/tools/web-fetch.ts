import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchPageAsMarkdown, FetchError } from '../fetch/http-fetch.js';

export const webFetchInput = {
  url: z.string().url().describe('目标网页的 URL（仅支持 http/https）'),
};

export const webFetchDescription = `获取指定 URL 的网页内容，返回 Markdown 格式的正文。

- 自动去除导航、页脚、广告等噪音，提取主要内容区域
- HTML 转换为 Markdown 格式（对 AI 阅读友好）
- 内置 SSRF 防护，禁止访问内网地址和云元数据端点
- 正文超过 100KB 会被截断
- 不支持 JS 动态渲染页面（如需渲染请单独说明）`;

export function registerWebFetch(server: McpServer): void {
  server.registerTool(
    'web_fetch',
    { description: webFetchDescription, inputSchema: webFetchInput },
    async ({ url }) => {
      try {
        const markdown = await fetchPageAsMarkdown(url);
        return {
          content: [{ type: 'text', text: markdown }],
        };
      } catch (err) {
        const message =
          err instanceof FetchError
            ? `获取失败 [${err.code}]: ${err.message}`
            : `获取失败: ${err instanceof Error ? err.message : String(err)}`;
        return {
          isError: true,
          content: [{ type: 'text', text: message }],
        };
      }
    },
  );
}
