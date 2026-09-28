/** SearXNG 支持的时间范围（注意：没有 week） */
export type TimeRange = 'day' | 'month' | 'year';

export interface SearchOptions {
  /** 最大返回结果数，默认 10 */
  maxResults?: number;
  /** 时间范围过滤 */
  timeRange?: TimeRange;
  /** 搜索语言偏好，默认 auto（空字符串=让 SearXNG 按 query 自动判断） */
  language?: string;
  /** 页码，默认 1 */
  page?: number;
  /** 搜索分类（逗号分隔），如 general / it / science / news / images。不传则用 SearXNG 默认 */
  categories?: string;
  /** 指定引擎（逗号分隔的引擎名或 shortcut），如 google,bing / ddg。不传则用 SearXNG 默认 */
  engines?: string;
  /** 优先展示的域名列表，命中域名的结果会被提权到最前。传域名而非完整 URL */
  preferredSites?: string[];
}

export interface SearchResult {
  title: string;
  url: string;
  /** 摘要片段 */
  snippet: string;
  /** 来源引擎 */
  engines?: string[];
  /** SearXNG 综合评分（跨引擎合并后计算，仅用于排序参考） */
  score?: number;
}

/** 单次搜索尝试的记录（供空结果诊断输出） */
export interface SearchAttempt {
  /** 参数组合的简述，如 "原参数" / "去掉 language" / "engines=bing,google" */
  label: string;
  /** 本次请求实际使用的 language（未传为 undefined） */
  language?: string;
  /** 本次请求实际使用的 engines（未传为 undefined） */
  engines?: string;
  /** 本次请求实际使用的 categories（未传为 undefined） */
  categories?: string;
  /** 返回条数；请求抛错时为 -1（原因见 error） */
  resultCount: number;
  /** 请求抛错时的错误摘要 */
  error?: string;
}

/** 搜索过程诊断：尝试了什么、哪些引擎无响应 */
export interface SearchDiagnostics {
  attempts: SearchAttempt[];
  /** SearXNG 报告无响应的引擎名（跨尝试去重） */
  unresponsiveEngines: string[];
}

/** 带诊断的搜索结果 */
export interface SearchOutcome {
  results: SearchResult[];
  diagnostics: SearchDiagnostics;
}

/** 搜索后端抽象 */
export interface SearchProvider {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  /** 带诊断信息的搜索（search 的超集，降级重试链使用） */
  searchDetailed(query: string, options?: SearchOptions): Promise<SearchOutcome>;
}
