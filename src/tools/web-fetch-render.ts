import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { browserFetchProvider } from '../fetch/browser-fetch.js';
import { FetchError } from '../fetch/http-fetch.js';
import { SsrfError } from '../fetch/url-validator.js';
import { deferParam, submitDeferTask, syncRunCtx } from '../tasks/defer.js';
import type { TaskRunContext, TaskToolResult } from '../tasks/manager.js';

export const webFetchRenderInput = {
  url: z.string().url().describe('目标网页的 URL（仅支持 http/https）'),
  defer: deferParam,
};

export const webFetchRenderDescription = `使用无头浏览器渲染获取指定 URL 的网页内容，返回 Markdown 格式正文。

- 已启用 stealth 模式（navigator.webdriver 等指纹补丁），可绕过基础 WAF/反爬拦截
- 真实浏览器 UA + 1920×1080 视口 + zh-CN 语言环境
- 用于 JS 动态渲染页面（SPA、前端框架渲染），web_fetch 获取不到内容或被 WAF 拦截时使用
- 启动浏览器开销大、响应慢（冷启动 1-3 秒，慢站点可达数十秒），资源消耗高
- 慢站点不需要立刻拿结果时可传 defer=true 脱手，用返回的 taskId 稍后经 get_result 取
- 优先尝试 web_fetch，仅在返回为空或内容疑似 WAF 挑战页时才用本工具
- 内置 SSRF 防护，禁止访问内网地址和云元数据端点
- 正文超过 100KB 会被截断`;

/** runWebFetchRender 的输入（工具 schema 的推断类型） */
export interface WebFetchRenderRunInput {
  url: string;
}

/**
 * 共享执行逻辑：同步回调与异步任务执行器走同一函数。
 */
export async function runWebFetchRender(
  input: WebFetchRenderRunInput,
  ctx: TaskRunContext,
): Promise<TaskToolResult> {
  const { url } = input;
  ctx.setProgress('浏览器渲染中');
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
}

export function registerWebFetchRender(server: McpServer): void {
  server.registerTool(
    'web_fetch_render',
    { description: webFetchRenderDescription, inputSchema: webFetchRenderInput },
    async (input) => {
      if (input.defer) {
        const { defer: _defer, ...params } = input;
        return submitDeferTask('web_fetch_render', params);
      }
      return runWebFetchRender(input, syncRunCtx);
    },
  );
}
