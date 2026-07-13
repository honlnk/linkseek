/** SearXNG 支持的时间范围（注意：没有 week） */
export type TimeRange = 'day' | 'month' | 'year';

export interface SearchOptions {
  /** 最大返回结果数，默认 10 */
  maxResults?: number;
  /** 时间范围过滤 */
  timeRange?: TimeRange;
  /** 搜索语言偏好，默认 zh-CN */
  language?: string;
  /** 页码，默认 1 */
  page?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  /** 摘要片段 */
  snippet: string;
  /** 来源引擎 */
  engines?: string[];
}

/** 搜索后端抽象 */
export interface SearchProvider {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}
