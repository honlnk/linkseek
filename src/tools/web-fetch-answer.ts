import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchPageAsMarkdown, FetchError } from '../fetch/http-fetch.js';
import { isLowQualityContent } from '../fetch/content-quality.js';
import { browserFetchProvider } from '../fetch/browser-fetch.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { resolveProvider, toConnectionConfig } from '../llm/provider-store.js';
import { getAdapter, AiError } from '../llm/index.js';
import type { ChatMessage } from '../llm/types.js';
import { requestContext } from '../utils/request-context.js';
import { estimateStepCost, round6 } from '../utils/cost.js';

export const webFetchAnswerInput = {
  url: z.string().url().describe('目标网页的 URL（仅支持 http/https）'),
  prompt: z
    .string()
    .min(1)
    .describe('想了解的问题。AI 会根据网页内容回答这个问题，而非返回原始正文'),
  model: z
    .string()
    .optional()
    .describe(
      '指定 AI 模型：传入 list_models 返回的「名称」（name 字段）。不传则用默认模型。' +
        '若返回错误说模型不存在，请先调 list_models 查看可用模型，再传入正确的名称重试。',
    ),
};

export const webFetchAnswerDescription = `获取指定 URL 的网页内容，并用 AI 回答你的问题。

- 先抓取网页正文（Markdown），再用配置的 AI 模型针对你的 prompt 回答
- 自动处理 WAF 拦截：检测到挑战页时自动降级到浏览器渲染
- 返回的是 AI 的精简回答（几百字），不是原始网页正文
- 适合需要快速从网页提取特定信息的场景

与 web_fetch 的区别：web_fetch 返回原始 Markdown（需自己阅读），本工具直接给出答案。`;

export function registerWebFetchAnswer(server: McpServer): void {
  server.registerTool(
    'web_fetch_answer',
    { description: webFetchAnswerDescription, inputSchema: webFetchAnswerInput },
    async ({ url, prompt, model }) => {
      // 1. 解析 Provider
      const provider = await resolveProvider(model);
      if (!provider) {
        const hint = model
          ? `指定的模型「${model}」不存在或已禁用。请调 list_models 查看可用模型，确认正确的名称后重试。`
          : '当前未配置默认 AI 模型。请在后台管理中配置 LLM Provider，或调 list_models 查看可用选项。';
        return {
          isError: true,
          content: [{ type: 'text', text: hint }],
        };
      }

      // 2. 抓取页面正文
      let content_text = '';
      try {
        let markdown = await fetchPageAsMarkdown(url);

        // 检测低质内容（WAF 挑战页），自动降级到浏览器渲染
        if (isLowQualityContent(markdown)) {
          if (config.BROWSER_FETCH_ENABLED) {
            logger.warn({ url }, 'web_fetch_answer 疑似 WAF 挑战页，降级到浏览器渲染');
            markdown = await browserFetchProvider.renderAsMarkdown(url);
          }
        }
        content_text = markdown;
      } catch (err) {
        // 403/429 也尝试浏览器降级
        if (
          err instanceof FetchError &&
          (err.statusCode === 403 || err.statusCode === 429) &&
          config.BROWSER_FETCH_ENABLED
        ) {
          logger.warn({ url, reason: err.message }, 'web_fetch_answer HTTP 失败，降级到浏览器渲染');
          try {
            content_text = await browserFetchProvider.renderAsMarkdown(url);
          } catch (renderErr) {
            const reason = renderErr instanceof Error ? renderErr.message : String(renderErr);
            return {
              isError: true,
              content: [{ type: 'text', text: `页面获取失败（${err.message}），浏览器渲染也失败：${reason}` }],
            };
          }
        } else {
          const reason = err instanceof Error ? err.message : String(err);
          return {
            isError: true,
            content: [{ type: 'text', text: `页面获取失败: ${reason}` }],
          };
        }
      }

      if (!content_text || content_text.trim().length === 0) {
        return {
          isError: true,
          content: [{ type: 'text', text: '页面正文为空，无法分析' }],
        };
      }

      // 3. 调用 LLM 回答问题
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            '你是一个信息提取助手。根据以下网页内容，准确回答用户的问题。' +
            '回答要简洁、直接、信息密度高。如果网页内容无法回答问题，请明确说明。' +
            '回答使用中文（除非用户用英文提问）。',
        },
        {
          role: 'user',
          content: `网页内容：\n\n${content_text.slice(0, 12000)}\n\n---\n\n问题：${prompt}`,
        },
      ];

      try {
        const conn = toConnectionConfig(provider);
        const adapter = getAdapter(provider.protocol);
        const result = await adapter.chatComplete({
          messages,
          conn,
          temperature: 0.3,
          maxTokens: config.LLM_MAX_TOKENS,
          timeout: config.LLM_TIMEOUT,
        });

        logger.info(
          { url, provider: provider.name, promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens },
          'web_fetch_answer 完成',
        );

        // 回写请求上下文，供中间件层记录 token 用量与成本
        const store = requestContext.getStore();
        if (store) {
          store.ai = {
            providerId: provider.id,
            model: provider.model,
            usage: result.usage,
            cost: round6(estimateStepCost(result.usage, provider.pricing)),
          };
        }

        return { content: [{ type: 'text', text: result.content }] };
      } catch (err) {
        const reason = err instanceof AiError
          ? `LLM 调用失败 (${err.status}): ${err.message}`
          : `LLM 调用失败: ${err instanceof Error ? err.message : String(err)}`;
        logger.error({ url, provider: provider.name, err: reason }, 'web_fetch_answer LLM 调用失败');
        return {
          isError: true,
          content: [{ type: 'text', text: `${reason}\n\n可调 list_models 查看其他可用模型，或在 model 参数中指定其他 Provider 重试。` }],
        };
      }
    },
  );
}
