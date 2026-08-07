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

    // 语言推断：用户显式传的 language 优先，没传则按 query 内容启发式判断
    const effectiveLang = language || detectLanguage(query);

    const params = new URLSearchParams({
      q: query,
      format: 'json',
      pageno: String(page),
      safesearch: '0',
    });
    // language 仅在有值时设置（空字符串会导致 SearXNG 返回 400）
    if (effectiveLang) params.set('language', effectiveLang);
    if (timeRange) params.set('time_range', timeRange);
    if (categories) params.set('categories', categories);
    if (engines) params.set('engines', engines);

    const url = `${this.baseUrl}/search?${params}`;
    logger.debug({ url, query, effectiveLang }, 'SearXNG 搜索请求');

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        // Accept-Language 配合 effectiveLang，让 SearXNG 的 default_lang: auto 判断更准
        AcceptLanguage: toAcceptLanguage(effectiveLang),
      },
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

    // 按有效 score 降序排序（原始 score + 来源权威性 bonus）
    const scored = raw.map((r) => {
      const boost = getAuthorityBoost(r.url);
      const effectiveScore = (r.score ?? 0) + boost.bonus;
      return { result: r, effectiveScore, boost };
    });
    scored.sort((a, b) => b.effectiveScore - a.effectiveScore);
    const sorted = scored.map((s) => s.result);

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

/**
 * 按 query 内容启发式判断语言。
 * - 含中日韩字符 → zh-CN（CJK 引擎覆盖好，中文结果质量高）
 * - 纯拉丁字母/数字/符号 → en（避免被中文引擎带偏）
 * - 无法判断（纯数字/符号）→ ''（交给 SearXNG auto）
 *
 * 注意：少量中文站点转载英文技术词时会混入 CJK 字符，此时判 zh-CN 是合理的
 * （用户大概率想看中文资料）。纯英文 query 走 en 是核心优化点。
 */
function detectLanguage(query: string): string {
  // CJK 统一表意 + 平假名/片假名 + 韩文音节
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(query)) return 'zh-CN';
  // 有拉丁字母（技术关键词如 "Claude Code"）→ en
  if (/[a-zA-Z]/.test(query)) return 'en';
  return '';
}

/** 把 language 代码转成 Accept-Language header 值 */
function toAcceptLanguage(lang: string): string {
  switch (lang) {
    case 'en':
      return 'en-US,en;q=0.9';
    case 'zh-CN':
      return 'zh-CN,zh;q=0.9';
    default:
      // 不确定时给一个中英混合的偏好（英文优先，兼顾中文）
      return 'en-US,en;q=0.8,zh-CN;q=0.6';
  }
}

/**
 * 来源权威性加权：在 SearXNG 原始 score 基础上加固定 bonus。
 *
 * SearXNG score 通常在 1~10 区间，bonus 设 1~5 足以在同分段内提权，
 * 但不至于完全覆盖原始相关性判断（不会把 score=1 的官方源强提到 score=10 的博客前面）。
 *
 * 设计原则：
 * - 只提权，不降权（不主动惩罚任何来源，避免误杀）
 * - 精确匹配优先，正则兜底
 * - bonus 随权威性递减：官方源码 > 权威百科 > 技术文档 > 社区 > 官方域名后缀
 */
const AUTHORITY_RULES: { pattern: RegExp; bonus: number }[] = [
  // 官方源码仓库 / 开发者平台，最高权威
  { pattern: /^github\.com\//, bonus: 5 },
  // 权威百科
  { pattern: /^[a-z]+\.wikipedia\.org\//, bonus: 4 },
  // 官方技术文档（高频官方站，精确匹配域名）
  { pattern: /^developer\.mozilla\.org\//, bonus: 4 },
  // 开发者社区
  { pattern: /^(stackoverflow|stackexchange|serverfault)\.com\//, bonus: 3 },
  // 各技术栈官方文档站
  {
    pattern:
      /^(react|nextjs|vuejs|nuxt|angular|nodejs|bun\.sh|deno\.land|tailwindcss|typescriptlang|python|go\.dev|rust-lang|kotlinlang|jetbrains|vitejs|svelte)\./,
    bonus: 3,
  },
  // 官方域名后缀（粗粒度兜底，bonus 低避免误提权）
  { pattern: /\.(dev|org)\//, bonus: 1 },
];

interface AuthorityBoost {
  bonus: number;
}

/** 计算 URL 的权威性加权 bonus（0 = 无提权） */
function getAuthorityBoost(url: string | undefined): AuthorityBoost {
  if (!url) return { bonus: 0 };
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return { bonus: 0 };
  }
  const fullForMatch = hostname + '/'; // 补斜杠让正则 ^xxx/ 能匹配根路径
  let bonus = 0;
  for (const rule of AUTHORITY_RULES) {
    if (rule.pattern.test(fullForMatch)) {
      bonus = Math.max(bonus, rule.bonus); // 多条命中取最高 bonus，不叠加
    }
  }
  return { bonus };
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
