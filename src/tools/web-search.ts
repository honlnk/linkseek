import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { timeRangeValues } from '../search/searxng.js';
import type { TimeRange } from '../search/provider.js';
import { searchWithFallback } from '../search/fallback.js';
import { buildEmptyReport } from '../search/empty-hint.js';
import { formatAuthorDateLine } from '../search/result-format.js';

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
    .describe(
      '时间范围过滤：day（一天内）/ month（一月内）/ year（一年内）/ week（一周内，仅视频类引擎如 bilibili 支持；general 搜索引擎普遍不支持 week，传了会导致引擎被跳过、召回变窄，通用时效过滤请用 day/month/year）',
    ),
  language: z
    .string()
    .optional()
    .describe(
      '搜索语言偏好。一般不传：SearXNG 会按查询内容自动处理，显式指定（尤其 zh-CN）在部分引擎上反而收窄召回导致空结果。仅在明确只要特定语言的结果时使用。',
    ),
  categories: z
    .string()
    .optional()
    .describe(
      '搜索分类（逗号分隔），按内容类型缩小范围。常用值：general（默认）、it（技术/开发）、science（学术）、news（新闻）、images（图片）、videos（视频，含 B 站等视频源）、files（文件下载）。不传则用 general。',
    ),
  engines: z
    .string()
    .optional()
    .describe(
      '指定本地 SearXNG 引擎（逗号分隔的引擎名或 shortcut）：google、bing、duckduckgo（ddg）、wikipedia、brave、bilibili 等。搜 B 站视频 → engines="bilibili"（结果带作者与发布时间）。传了此参数会跳过云端商业引擎，直接用指定本地引擎搜索。不传则默认云端引擎优先（未命中自动回退本地）。',
    ),
  preferred_sites: z
    .array(z.string().min(1))
    .max(10)
    .optional()
    .describe(
      '优先展示的域名列表，如 ["github.com", "react.dev"]。传域名而非完整 URL；匹配域名及其子域名的结果会排在前面。指定网站不在搜索结果中时不会凭空生成结果。',
    ),
  provider: z
    .enum(['auto', 'cloud'])
    .optional()
    .describe(
      '搜索路径（历史参数，现两者等价）：默认云端商业引擎优先，未命中自动回退本地 SearXNG 降级链。auto 与 cloud 行为一致，可不传；唯一走纯本地路径的方式是显式传 engines 指定本地引擎。',
    ),
};

export const webSearchDescription = `联网搜索，返回关键词匹配的网页列表。

- 默认云端商业引擎优先（后台配置的引擎列表），未命中自动回退本地 SearXNG 元搜索引擎（聚合 Google、Bing、Wikipedia 等多源并逐级放宽参数重试）
- 返回结构化结果：每条含标题、URL、摘要，按相关性排序，自动去重
- 可用 preferred_sites 指定优先域名，适合限定优先参考的官网、GitHub 仓库或文档站
- 空结果时返回完整诊断（云端与本地各自尝试过什么）和下一步建议

如何写查询（重要）：
- 用空格分隔的关键词，不要写完整句子（如 "Next.js 15 app router 迁移"）
- 不要使用 OR / AND / 引号 / site: 等搜索运算符——部分引擎不支持，会导致 0 结果

如何选择参数：
- 技术类问题 → categories=it；学术论文 → categories=science
- 需要特定官网或站点优先 → preferred_sites=["example.com"]
- 想强制走本地 SearXNG 的特定引擎 → 传 engines（如 "bing,google"）`;

export function registerWebSearch(server: McpServer): void {
  server.registerTool(
    'web_search',
    { description: webSearchDescription, inputSchema: webSearchInput },
    async ({ query, maxResults, timeRange, language, categories, engines, preferred_sites, provider }) => {
      try {
        const { results, diagnostics } = await searchWithFallback(
          query,
          {
            maxResults,
            timeRange: timeRange as TimeRange | undefined,
            language,
            categories,
            engines,
            preferredSites: preferred_sites,
          },
          provider ?? 'auto',
        );

        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: buildEmptyReport(query, diagnostics) }],
          };
        }

        // 格式化为 AI 友好的文本（bilibili 等引擎的结果在 URL 行后带「作者｜发布」元信息行）
        const lines = results.map((r, i) => {
          const meta = formatAuthorDateLine(r);
          const head = `## ${i + 1}. ${r.title}\nURL: ${r.url}`;
          return meta ? `${head}\n${meta}\n${r.snippet}` : `${head}\n${r.snippet}`;
        });
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
