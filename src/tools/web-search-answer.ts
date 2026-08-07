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
import { resolveProvider, toConnectionConfig } from '../llm/provider-store.js';
import { getAdapter, AiError } from '../llm/index.js';
import type { ChatMessage } from '../llm/types.js';

export const webSearchAnswerInput = {
  query: z.string().min(1).describe('搜索关键词'),
  prompt: z
    .string()
    .optional()
    .describe('想了解的问题。不传则用 query 作为问题。AI 会综合搜索到的多个页面内容回答'),
  fetchCount: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('抓取前 N 个搜索结果的页面正文供 AI 分析，默认 3'),
  searchMaxResults: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe('搜索结果总数，默认 10'),
  model: z
    .string()
    .optional()
    .describe(
      '指定 AI 模型：传入 list_models 返回的「名称」（name 字段）。不传则用默认模型。' +
        '若返回错误说模型不存在，请先调 list_models 查看可用模型，再传入正确的名称重试。',
    ),
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
    .describe('指定搜索引擎（逗号分隔）：google、bing、ddg、wikipedia 等。不传则自动选择。'),
  preferred_sites: z
    .array(z.string().min(1))
    .max(10)
    .optional()
    .describe(
      '优先展示并抓取的域名列表，如 ["github.com", "react.dev"]。传域名而非完整 URL；匹配域名及其子域名的结果会排在前面。',
    ),
};

export const webSearchAnswerDescription = `搜索关键词，抓取多个结果页面，用 AI 综合回答你的问题。

- 一次完成「搜索 + 抓取 + AI 分析」全流程
- 搜索后并行抓取前 N 个结果的页面正文（自动处理 WAF 拦截）
- 将所有正文作为 context 交给 AI，针对你的问题给出精简回答
- 返回的是 AI 的综合回答（几百字），不是原始搜索列表

与 web_search_and_fetch 的区别：search_and_fetch 返回原始标题+正文（需自己阅读），本工具直接给出 AI 答案。
适合需要快速从多个来源获取答案的场景。`;

export function registerWebSearchAnswer(server: McpServer): void {
  server.registerTool(
    'web_search_answer',
    { description: webSearchAnswerDescription, inputSchema: webSearchAnswerInput },
    async ({
      query,
      prompt,
      fetchCount = 3,
      searchMaxResults = 10,
      model,
      timeRange,
      language,
      categories,
      engines,
      preferred_sites,
    }) => {
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

      // 2. 搜索
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

      // 3. 并行抓取正文（复用 search_and_fetch 的抓取+WAF降级逻辑）
      const targets = results.slice(0, fetchCount);
      const fetchResults = await Promise.allSettled(
        targets.map(async (r) => {
          try {
            let markdown = await fetchPageAsMarkdown(r.url);
            // WAF 降级
            if (isLowQualityContent(markdown) && config.BROWSER_FETCH_ENABLED) {
              logger.warn({ url: r.url }, 'web_search_answer 疑似 WAF，降级浏览器渲染');
              markdown = await browserFetchProvider.renderAsMarkdown(r.url);
            }
            return { title: r.title, url: r.url, snippet: r.snippet, content: markdown };
          } catch (err) {
            // 403/429 也降级
            if (
              err instanceof FetchError &&
              (err.statusCode === 403 || err.statusCode === 429) &&
              config.BROWSER_FETCH_ENABLED
            ) {
              logger.warn({ url: r.url }, 'web_search_answer HTTP 失败，降级浏览器渲染');
              try {
                const markdown = await browserFetchProvider.renderAsMarkdown(r.url);
                return { title: r.title, url: r.url, snippet: r.snippet, content: markdown };
              } catch {
                return { title: r.title, url: r.url, snippet: r.snippet, content: '' };
              }
            }
            return { title: r.title, url: r.url, snippet: r.snippet, content: '' };
          }
        }),
      );

      // 4. 汇总每个 target 的抓取结果，统一编号（连续不跳号）
      //    无论抓取成功与否都纳入来源列表，避免模型引用的 [n] 与最终来源列表错位。
      interface SourceRecord {
        id: number;
        title: string;
        url: string;
        snippet: string;
        content: string;
        fetchOk: boolean;
      }
      const sources: SourceRecord[] = [];
      for (let i = 0; i < targets.length; i++) {
        const r = targets[i];
        const fr = fetchResults[i];
        const value = fr.status === 'fulfilled' ? fr.value : null;
        sources.push({
          id: i + 1,
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          content: value?.content ?? '',
          fetchOk: !!(value && value.content && value.content.trim().length > 0),
        });
      }

      // 5. 拼装 context 给 LLM（只放有正文的来源；仅有摘要的也保留，让模型知道摘要存在）
      const contextParts: string[] = [];
      for (const s of sources) {
        const head = `## 来源 ${s.id}: ${s.title}\nURL: ${s.url}\n摘要: ${s.snippet}`;
        if (s.fetchOk) {
          contextParts.push(`${head}\n\n${s.content.slice(0, 4000)}`);
        } else {
          contextParts.push(`${head}\n\n（正文获取失败，仅有上述摘要）`);
        }
      }

      const question = prompt?.trim() || query;
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            '你是一个搜索问答助手。根据以下从网络搜索到的多个页面内容，准确回答用户的问题。' +
            '回答要综合多个来源的信息，简洁、准确、信息密度高。' +
            '在关键信息后标注来源编号（如 [1] [2]）。如果内容无法回答问题，请明确说明。' +
            '回答使用中文（除非用户用英文提问）。\n\n' +
            '重要：只输出回答正文，不要在回答末尾生成「来源」「参考资料」「Sources」等独立列表，也不要重复列出 URL；' +
            '来源编号对应的完整 URL 列表会由系统统一追加。',
        },
        {
          role: 'user',
          content: `以下是搜索「${query}」找到的页面内容：\n\n${contextParts.join('\n\n---\n\n')}\n\n---\n\n问题：${question}`,
        },
      ];

      // 6. 调用 LLM
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
          { query, provider: provider.name, promptTokens: result.usage?.promptTokens, completionTokens: result.usage?.completionTokens },
          'web_search_answer 完成',
        );

        // 7. 模型偶尔会忽略指令自行追加来源章节，做保守清理：仅移除回答末尾的来源标题块
        const cleanedAnswer = stripTrailingSourceSection(result.content);
        // 工具统一追加来源列表（与 context 编号一致，连续不跳号）
        const sourceList = sources.map((s) => {
          const mark = s.fetchOk ? '' : '（正文获取失败，仅有摘要）';
          return `[${s.id}] ${s.title} (${s.url})${mark ? ' ' + mark : ''}`;
        });
        const text = `${cleanedAnswer}\n\n---\n**来源：**\n${sourceList.join('\n')}`;
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        const reason = err instanceof AiError
          ? `LLM 调用失败 (${err.status}): ${err.message}`
          : `LLM 调用失败: ${err instanceof Error ? err.message : String(err)}`;
        logger.error({ query, provider: provider.name, err: reason }, 'web_search_answer LLM 调用失败');
        return {
          isError: true,
          content: [{ type: 'text', text: `${reason}\n\n可调 list_models 查看其他可用模型，或在 model 参数中指定其他 Provider 重试。` }],
        };
      }
    },
  );
}

/**
 * 匹配来源/参考资料章节标题的正则。
 * 支持：中文「来源 / 参考资料 / 参考来源 / 引用」、英文「Sources / References / Citations」。
 * 行首可有 1-3 个 # 或 * / -（Markdown 标题或强调），标题前后可有空格和冒号。
 */
const SOURCE_SECTION_TITLES =
  /^\s{0,3}(?:#{1,3}\s*|[*-]{1,2}\s*)?(来源|参考资料|参考来源|引用|sources|references|citations)\s*:?\s*\**\s*$/i;

/**
 * 判断一行是否像「来源条目」：以编号或链接开头。
 * 命中 `[1] ...`、`1. ...`、`- [1] ...`、纯 URL 行、Markdown 链接 `[text](url)` 行。
 */
function looksLikeSourceLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true; // 来源块内部的空行也算属于该块
  // [1] / [n] 引用编号开头
  if (/^\[?\d+\]?[.)\s]/.test(trimmed)) return true;
  // Markdown 链接或裸 URL
  if (/^\[.+]\(https?:\/\//i.test(trimmed) || /^https?:\/\//i.test(trimmed)) return true;
  // 列表项 `- xxx (url)` 这类
  if (/^[-*]\s+.*https?:\/\//i.test(trimmed)) return true;
  return false;
}

/**
 * 保守清理：移除模型在回答末尾自行生成的「来源 / 参考资料 / Sources」章节。
 *
 * 设计原则：
 * - 只处理回答末尾出现的、标题明确的来源区块
 * - 不删除正文中的 [n] 引用
 * - 不删除正文里普通的链接或段落
 * - 来源区块判定为「标题行 + 连续若干行来源条目（允许空行）」
 * - 若该区块下还有正文内容，则不视为纯来源章节，不删除
 *
 * 这样即便模型偶尔忽略 prompt 指令自行追加来源，也不会和工具追加的列表重复。
 */
function stripTrailingSourceSection(answer: string): string {
  const lines = answer.split('\n');
  // 从后向前找最后一个来源标题
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SOURCE_SECTION_TITLES.test(lines[i])) {
      // 检查标题之后是否全是来源条目/空行（直到文件末尾）
      let allSourceLines = true;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t === '') continue;
        if (!looksLikeSourceLine(lines[j])) {
          allSourceLines = false;
          break;
        }
      }
      if (allSourceLines) {
        // 删除从标题开始到末尾的内容
        // 同时去掉标题前可能存在的分隔符（---）和多余空行
        let cutAt = i;
        while (cutAt > 0 && /^\s{0,3}---+\s*$/.test(lines[cutAt - 1])) cutAt--;
        return lines.slice(0, cutAt).join('\n').replace(/\s+$/, '');
      }
    }
  }
  return answer;
}
