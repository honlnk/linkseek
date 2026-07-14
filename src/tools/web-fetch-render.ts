import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { browserFetchProvider } from '../fetch/browser-fetch.js';
import { FetchError } from '../fetch/http-fetch.js';
import { SsrfError } from '../fetch/url-validator.js';

export const webFetchRenderInput = {
  url: z.string().url().describe('目标网页的 URL（仅支持 http/https）'),
};

export const webFetchRenderDescription = `使用无头浏览器渲染获取指定 URL 的网页内容，返回 Markdown 格式正文。

- 用于 JS 动态渲染页面（SPA、前端框架渲染），web_fetch 获取不到内容时使用
- 启动浏览器开销大、响应慢（冷启动 1-3 秒），资源消耗高
- 优先尝试 web_fetch，仅在返回为空或页面为 JS 渲染时才用本工具
- 内置 SSRF 防护，禁止访问内网地址和云元数据端点
- 正文超过 100KB 会被截断`;

export function registerWebFetchRender(server: McpServer): void {
  server.registerTool(
    'web_fetch_render',
    { description: webFetchRenderDescription, inputSchema: webFetchRenderInput },
    async ({ url }) => {
      try {
        const markdown = await browserFetchProvider.renderAsMarkdown(url);
        return {
          content: [{ type: 'text', text: markdown }],
        };
      } catch (err) {
        const message =
          err instanceof SsrfError
            ? `获取失败 [ssrf]: ${err.message}`
            : err instanceof FetchError
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
