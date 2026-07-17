import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { fetch } from 'undici';
import { internalAgent } from '../fetch/dispatcher.js';
import type { SearchProvider, SearchResult, SearchOptions, TimeRange } from './provider.js';

/**
 * SearXNG 响应中的单条结果字段（仅声明我们用到的）。
 * 完整字段见 searxng/result_types/_base.py。
 */
interface SearXngResult {
  url?: string;
  title?: string;
  content?: string;
  engines?: string[];
  score?: number;
  category?: string;
}

interface SearXngResponse {
  query?: string;
  results?: SearXngResult[];
  unresponsive_engines?: unknown[];
}

/**
 * SearXNG 搜索适配器。
 *
 * 调用 GET /search?q=...&format=json，需在 settings.yml 中启用 search.formats: [json]。
 * SearXNG 无 API Key 鉴权，靠网络隔离保护（容器内网 + Nginx 限制来源）。
 */
export class SearXngProvider implements SearchProvider {
  constructor(private readonly baseUrl: string = config.SEARXNG_URL) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const {
      maxResults = 10,
      timeRange,
      language = 'zh-CN',
      page = 1,
    } = options;

    const params = new URLSearchParams({
      q: query,
      format: 'json',
      pageno: String(page),
      language,
      safesearch: '0',
    });
    if (timeRange) params.set('time_range', timeRange);

    const url = `${this.baseUrl}/search?${params}`;
    logger.debug({ url, query }, 'SearXNG 搜索请求');

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      dispatcher: internalAgent, // SearXNG 是可信内网服务，不走代理也不做 SSRF 拦截
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(
        `SearXNG 返回 HTTP ${response.status}` +
          (response.status === 403 ? '（请检查 settings.yml 是否启用了 search.formats: [json]）' : ''),
      );
    }

    const data = (await response.json()) as SearXngResponse;
    const raw = data.results ?? [];

    // 转换 + 过滤无效项 + URL 去重
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const r of raw) {
      if (!r.url || !r.title) continue;
      const canonical = canonicalizeUrl(r.url);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      results.push({
        title: r.title,
        url: r.url,
        snippet: r.content?.trim() || '',
        engines: r.engines,
      });
      if (results.length >= maxResults) break;
    }

    logger.info({ query, count: results.length }, 'SearXNG 搜索完成');
    return results;
  }
}

/** URL 规范化去重（去除 fragment、统一协议为小写） */
function canonicalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString().toLowerCase();
  } catch {
    return url;
  }
}

/** 进程内单例 */
export const searchProvider: SearchProvider = new SearXngProvider();

/** 供 zod 引用的 time_range 枚举 */
export const timeRangeValues: TimeRange[] = ['day', 'month', 'year'];
