import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchProvider } from '../search/searxng.js';
import { timeRangeValues } from '../search/searxng.js';
import { buildEmptyHint } from '../search/empty-hint.js';
import { fetchPageAsMarkdown, FetchError } from '../fetch/http-fetch.js';
import { isLowQualityContent } from '../fetch/content-quality.js';
import { browserFetchProvider } from '../fetch/browser-fetch.js';
import { config } from '../config.js';
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
  language: z
    .string()
    .optional()
    .describe('搜索语言偏好，如 zh-CN、en、all。不传则自动判断'),
  categories: z
    .string()
    .optional()
    .describe(
      '搜索分类（逗号分隔），按内容类型缩小范围。常用值：general（默认）、it（技术/开发）、science（学术）、news（新闻）、images（图片）、videos（视频）、files（文件下载）。不传则用 general。',
    ),
  engines: z
    .string()
    .optional()
    .describe(
      '指定搜索引擎（逗号分隔）：google、bing、ddg、wikipedia 等。不传则自动选择。',
    ),
  preferred_sites: z
    .array(z.string().min(1))
    .max(10)
    .optional()
    .describe(
      '优先展示并抓取的域名列表，如 ["github.com", "react.dev"]。传域名而非完整 URL；匹配域名及其子域名的结果会排在前面。',
    ),
};

export const searchAndFetchDescription = `搜索关键词并自动获取前几个结果的页面正文，一次调用完成「搜索 + 获取」。

- 先搜索获取结果列表，再并行抓取前 N 个页面的 Markdown 正文
- 单个页面获取失败不影响其他结果（失败项会标注原因）
- 适合需要快速获取多个来源内容的场景

输出包含每个结果的标题、URL、摘要，以及成功获取的页面正文。`;

/**
 * 判断 HTTP 抓取失败的原因是否适合降级到浏览器渲染。
 *
 * 适合降级的情况（浏览器有 stealth + JS 执行能力，能绕过）：
 * - 403 / 429：WAF/反爬拦截，浏览器有真实指纹可绕过
 * - SPA 空正文：页面靠 JS 渲染，HTTP 抓取拿不到内容
 *
 * 不适合降级的情况（浏览器也救不了）：
 * - SSRF 拦截：安全策略，不应绕过
 * - 响应体过大：浏览器同样会超限
 * - 重定向超限：URL 问题，非渲染问题
 * - 纯网络/超时错误：连通性问题，浏览器大概率也连不上
 */
function shouldFallbackToBrowser(err: unknown): boolean {
  if (!(err instanceof FetchError)) return false;
  // 403 / 429 → WAF / 反爬，stealth 浏览器可绕过
  if (err.code === 'http' && (err.statusCode === 403 || err.statusCode === 429)) return true;
  // SPA 空正文 → 需要 JS 执行
  if (err.code === 'http' && err.statusCode === undefined && /SPA|web_fetch_render/.test(err.message)) return true;
  return false;
}

export function registerSearchAndFetch(server: McpServer): void {
  server.registerTool(
    'web_search_and_fetch',
    { description: searchAndFetchDescription, inputSchema: searchAndFetchInput },
    async ({ query, fetchCount = 3, searchMaxResults = 10, timeRange, language, categories, engines, preferred_sites }) => {
      // 1. 搜索
      let results;
      try {
        results = await searchProvider.search(query, {
          maxResults: searchMaxResults,
          timeRange: timeRange as 'day' | 'month' | 'year' | undefined,
          language,
          categories,
          engines,
          preferredSites: preferred_sites,
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
          content: [{ type: 'text', text: `未找到与「${query}」相关的结果。${buildEmptyHint(categories, engines)}` }],
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
          // 检测 WAF 挑战页 / 乱码内容
          if (isLowQualityContent(fr.value)) {
            // 信号驱动降级：检测到低质内容 → 自动用 stealth 浏览器重抓
            const section = await tryBrowserFallback(r.url, header);
            sections.push(section);
          } else {
            // 正常内容：截取正文摘要（避免单条过长，整篇正文已有 100KB 截断）
            const body = fr.value.slice(0, 8000);
            sections.push(`${header}\n\n### 正文\n${body}`);
          }
        } else {
          const reason = fr.reason instanceof Error ? fr.reason.message : String(fr.reason);
          logger.warn({ url: r.url, reason }, 'search_and_fetch 单页获取失败');

          // 403/429/SPA 空正文 → 浏览器可能绕过，尝试降级
          if (shouldFallbackToBrowser(fr.reason)) {
            const section = await tryBrowserFallback(r.url, header, reason);
            sections.push(section);
          } else {
            sections.push(`${header}\n\n### 正文获取失败\n${reason}`);
          }
        }
      }

      const summary = `搜索「${query}」找到 ${results.length} 条结果，已获取前 ${targets.length} 条正文：\n\n${sections.join('\n\n---\n\n')}`;

      return { content: [{ type: 'text', text: summary }] };
    },
  );
}

/**
 * 尝试用 stealth 浏览器渲染指定 URL，返回拼接好的 section 文本。
 *
 * 两种调用场景：
 * 1. HTTP 抓取成功但内容低质（WAF 挑战页）→ 直接降级
 * 2. HTTP 抓取失败（403/429/SPA 空正文）→ reason 参数携带原始错误信息
 *
 * @param url 目标 URL
 * @param header 已组装的结果标题段
 * @param httpFailReason HTTP 抓取失败原因（场景 2 传入，场景 1 省略）
 */
async function tryBrowserFallback(url: string, header: string, httpFailReason?: string): Promise<string> {
  if (!config.BROWSER_FETCH_ENABLED) {
    const hint = httpFailReason
      ? `HTTP 抓取失败（${httpFailReason}），浏览器未启用`
      : '疑似 WAF 挑战页或反爬拦截';
    logger.warn({ url }, 'search_and_fetch 浏览器未启用，仅标注');
    return `${header}\n\n### 正文获取失败\n${hint}，建议用 web_fetch_render 工具重试该 URL。`;
  }

  logger.warn({ url, httpFailReason }, 'search_and_fetch 自动降级到浏览器渲染');
  try {
    const rendered = await browserFetchProvider.renderAsMarkdown(url);
    if (rendered && !isLowQualityContent(rendered)) {
      const body = rendered.slice(0, 8000);
      return `${header}\n\n### 正文（经浏览器渲染）\n${body}`;
    }
    return `${header}\n\n### 正文获取失败\n浏览器渲染后仍为低质内容，建议手动用 web_fetch_render 工具检查该 URL。`;
  } catch (renderErr) {
    const reason = renderErr instanceof Error ? renderErr.message : String(renderErr);
    logger.warn({ url, reason }, 'search_and_fetch 浏览器降级也失败');
    const ctx = httpFailReason ? `HTTP ${httpFailReason}，浏览器渲染也失败` : '疑似 WAF 挑战页，浏览器渲染也失败';
    return `${header}\n\n### 正文获取失败\n${ctx}：${reason}`;
  }
}
