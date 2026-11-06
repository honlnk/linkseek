import type { SearchResult } from './provider.js';

/**
 * 结果元信息行：作者与发布时间（仅 bilibili 等提供该字段的引擎有值，general/商业引擎无）。
 *
 * 规则（docs/B站搜索接入-开发计划.md 2.3）：
 * - 字段存在才输出对应半段；两段都有时用「 ｜ 」连接，都没有返回空字符串
 * - 日期取 publishedDate 前 10 位（YYYY-MM-DD），不足 10 位原样输出
 *
 * 供 web_search / web_search_and_fetch 的文本输出口径共用，避免双份实现漂移。
 */
export function formatAuthorDateLine(result: Pick<SearchResult, 'author' | 'publishedDate'>): string {
  const parts: string[] = [];
  if (result.author) parts.push(`作者: ${result.author}`);
  if (result.publishedDate) {
    const date =
      result.publishedDate.length >= 10 ? result.publishedDate.slice(0, 10) : result.publishedDate;
    parts.push(`发布: ${date}`);
  }
  return parts.join(' ｜ ');
}
