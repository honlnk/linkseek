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
      language = '',
      page = 1,
      categories,
      engines,
    } = options;

    const params = new URLSearchParams({
      q: query,
      format: 'json',
      pageno: String(page),
      safesearch: '0',
    });
    // language 仅在有值时设置（空字符串会导致 SearXNG 返回 400）
    if (language) params.set('language', language);
    if (timeRange) params.set('time_range', timeRange);
    if (categories) params.set('categories', categories);
    if (engines) params.set('engines', engines);

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

    // 记录无响应引擎（不阻塞主流程，仅告警）
    if (data.unresponsive_engines && data.unresponsive_engines.length > 0) {
      logger.warn(
        { query, unresponsive_engines: data.unresponsive_engines },
        '部分搜索引擎无响应',
      );
    }

    // 按 score 降序排序（SearXNG 跨引擎合并后已计算综合 score；无 score 的保持原顺序排在后面）
    const sorted = [...raw].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    // 转换 + 过滤无效项 + URL 规范化去重
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const r of sorted) {
      if (!r.url || !r.title) continue;
      const canonical = canonicalizeUrl(r.url);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      results.push({
        title: r.title,
        url: r.url,
        snippet: r.content?.trim() || '',
        engines: r.engines,
        score: r.score,
      });
      if (results.length >= maxResults) break;
    }

    logger.info({ query, count: results.length }, 'SearXNG 搜索完成');
    return results;
  }
}

/** 需要剥离的追踪/营销参数（前缀匹配 + 精确匹配） */
const TRACKING_QUERY_PARAMS: string[] = [
  // Google / Facebook / Instagram 追踪
  'gclid', 'fbclid', 'igshid', 'dclid', 'msclkid',
  // Mailchimp / HubSpot / Marketo
  'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'mkt_tok',
  // 通用引用追踪
  'ref', 'ref_src', 'ref_url', 'referer', 'referrer',
  // 中国站点常见追踪
  'spm', 'scm', 'pvid', 'utm_source', 'campaign_id',
];

/**
 * URL 规范化去重：
 * - 剥离 fragment
 * - 剥离追踪参数（utm_* 前缀 + 已知追踪参数）
 * - 统一协议、主机为小写
 * - 去除默认端口（http:80 / https:443）
 * - 去除路径尾斜杠（根路径 / 保留）
 */
function canonicalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';

    // 剥离追踪参数：utm_ 前缀 + 精确匹配清单
    const keysToDelete: string[] = [];
    parsed.searchParams.forEach((_v, k) => {
      const lk = k.toLowerCase();
      if (lk.startsWith('utm_') || TRACKING_QUERY_PARAMS.includes(lk)) {
        keysToDelete.push(k);
      }
    });
    keysToDelete.forEach((k) => parsed.searchParams.delete(k));

    // 去默认端口
    const isDefaultPort =
      (parsed.protocol === 'http:' && parsed.port === '80') ||
      (parsed.protocol === 'https:' && parsed.port === '443');
    if (isDefaultPort) parsed.port = '';

    // 去尾斜杠（仅非根路径）
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    }

    // 协议 + 主机小写，路径/查询保持原样（查询参数大小写有语义）
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();

    return parsed.toString();
  } catch {
    return url;
  }
}

/** 进程内单例 */
export const searchProvider: SearchProvider = new SearXngProvider();

/** 供 zod 引用的 time_range 枚举 */
export const timeRangeValues: TimeRange[] = ['day', 'month', 'year'];
