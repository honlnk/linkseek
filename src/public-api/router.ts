import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { KeyStore } from '../auth/key-store.js';
import { searchProvider } from '../search/searxng.js';
import { buildEmptyHint } from '../search/empty-hint.js';
import { fetchPageDetailed, FetchError } from '../fetch/http-fetch.js';
import { browserFetchProvider } from '../fetch/browser-fetch.js';
import { isLowQualityContent } from '../fetch/content-quality.js';
import { SsrfError } from '../fetch/url-validator.js';
import { recordUsage } from '../utils/usage.js';
import { resolveQuotaKeys, quotaAvailable, consumeQuota, type QuotaKeys } from './quota.js';
import { burstAllow } from './burst.js';

/**
 * 公开 REST API（/v1/search、/v1/fetch）—— NovAI 内置联网搜索的服务端契约。
 *
 * 两类调用方：
 * - key 鉴权（Authorization: Bearer <key>）：自部署/付费形态，复用 ApiKey 校验，
 *   调用记 UsageLog（toolName 与 MCP 工具同名，渲染升级记 web_fetch_render）。
 * - 匿名绿灯（无 Authorization，供 NovAI 官方站点零配置用户）：
 *   Origin 白名单 + 日配额（加权）+ 突发限流。仅开放搜索与抓取；
 *   AI 工具（answer 系列）不在此暴露（烧宿主 LLM token，成本红线）。
 */

/** 绿灯超限/拒绝时返回给 NovAI 的文案——会被工具结果透传给模型，再由模型转述给用户 */
const QUOTA_EXCEEDED_MESSAGE =
  '免费搜索额度已用完（每日 50 次），明天自动恢复。如需不限量搜索，请在设置中配置自部署 linkseek 或第三方搜索 API Key。';

const searchBodySchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(30).optional(),
  timeRange: z.enum(['day', 'month', 'year']).optional(),
  language: z.string().optional(),
  categories: z.string().optional(),
  engines: z.string().optional(),
  preferredSites: z.array(z.string().min(1)).max(10).optional(),
});

const fetchBodySchema = z.object({
  url: z.string().url(),
  /** 'auto'：普通抓取命中低质量判定时自动升级浏览器渲染（一次请求内完成回退） */
  render: z.literal('auto').optional(),
});

type Caller = { kind: 'key'; keyId: string } | ({ kind: 'anon' } & QuotaKeys);

function errorJson(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/**
 * 鉴权分流。已通过 res 回复时返回 null。
 */
async function resolveCaller(req: Request, res: Response, keyStore: KeyStore): Promise<Caller | null> {
  const authorization = req.headers.authorization;
  if (authorization) {
    const token = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
    const record = token ? await keyStore.findByToken(token).catch(() => null) : null;
    if (!record) {
      errorJson(res, 401, 'UNAUTHORIZED', '无效或未启用的 API Key');
      return null;
    }
    return { kind: 'key', keyId: record.id };
  }

  // ---- 匿名绿灯通道 ----
  if (!config.DATABASE_URL) {
    // 匿名配额依赖 FreeUsage 表；无数据库时绿灯整体关闭（key 流量不受影响）
    errorJson(res, 503, 'GREENLIGHT_UNAVAILABLE', '匿名免费额度未启用（服务端未配置数据库）。请配置 API Key 使用。');
    return null;
  }
  const origin = req.headers.origin;
  if (!origin) {
    errorJson(res, 401, 'ORIGIN_REQUIRED', '匿名访问仅限浏览器内来自授权站点的请求；脚本/服务端调用请配置 API Key。');
    return null;
  }
  if (!config.PUBLIC_API_ALLOWED_ORIGINS.includes(origin)) {
    errorJson(res, 403, 'ORIGIN_FORBIDDEN', '当前来源不在免费额度白名单内。可配置 API Key 或自部署 linkseek。');
    return null;
  }
  const keys = resolveQuotaKeys(req.headers['x-novai-client-id'] as string | undefined, req.ip);
  if (!burstAllow(keys.identityKey, config.PUBLIC_API_BURST_PER_MINUTE)) {
    errorJson(res, 429, 'RATE_LIMITED', '请求过于频繁（每分钟 10 次上限），请稍后再试。');
    return null;
  }
  if (!(await quotaAvailable(keys))) {
    errorJson(res, 429, 'QUOTA_EXCEEDED', QUOTA_EXCEEDED_MESSAGE);
    return null;
  }
  return { kind: 'anon', ...keys };
}

interface FetchOutcome {
  finalUrl?: string;
  statusCode?: number;
  content: string;
  truncated: boolean;
  renderedBy: 'http' | 'browser';
  notice?: string;
}

function plainOutcome(result: { markdown: string; finalUrl: string; statusCode: number; truncated: boolean }): FetchOutcome {
  return {
    finalUrl: result.finalUrl,
    statusCode: result.statusCode,
    content: result.markdown,
    truncated: result.truncated,
    renderedBy: 'http',
  };
}

/**
 * render=auto：先普通 HTTP 抓取，命中低质量判定（WAF 挑战页/极短/低文本密度）
 * 自动升级 browserless 渲染。升级失败回退原始内容（有内容总比没有强）。
 */
async function fetchWithAutoRender(url: string): Promise<FetchOutcome> {
  try {
    const plain = await fetchPageDetailed(url);
    if (!isLowQualityContent(plain.markdown)) return plainOutcome(plain);
    if (!config.BROWSER_FETCH_ENABLED) {
      return {
        ...plainOutcome(plain),
        notice: '抓取内容疑似反爬拦截页或低质量内容；服务端未部署浏览器渲染，无法自动升级。',
      };
    }
    try {
      const rendered = await browserFetchProvider.renderAsMarkdownDetailed(url);
      return { content: rendered.markdown, truncated: rendered.truncated, renderedBy: 'browser' };
    } catch (renderErr) {
      logger.warn({ err: renderErr, url }, '自动渲染升级失败，回退原始抓取内容');
      return {
        ...plainOutcome(plain),
        notice: `浏览器渲染升级失败，返回原始抓取内容（疑似反爬拦截页）: ${errMessage(renderErr)}`,
      };
    }
  } catch (plainErr) {
    // 仅目标站 HTTP 层失败（SPA 空正文、WAF 403 等）值得升级渲染；
    // SSRF 拦截绝不升级（render 路径的 DNS 防护更弱），超时/超大/网络错误升级也无意义。
    const escalatable = plainErr instanceof FetchError && plainErr.code === 'http';
    if (!escalatable || !config.BROWSER_FETCH_ENABLED) throw plainErr;
    const rendered = await browserFetchProvider.renderAsMarkdownDetailed(url);
    return { content: rendered.markdown, truncated: rendered.truncated, renderedBy: 'browser' };
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createPublicApiRouter(keyStore: KeyStore): Router {
  const router = Router();

  // CORS：仅对白名单 Origin 发放行头（浏览器侧硬约束），预检直接 204。
  // 注意 Origin 可被非浏览器客户端伪造——它只挡误用，配额才是防线。
  router.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.PUBLIC_API_ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.append('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-NovAI-Client-Id');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  router.post('/search', async (req, res) => {
    const caller = await resolveCaller(req, res, keyStore);
    if (!caller) return;

    const parsed = searchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      errorJson(res, 400, 'BAD_REQUEST', `请求参数不合法: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
      return;
    }
    const { query, maxResults, timeRange, language, categories, engines, preferredSites } = parsed.data;

    try {
      const results = await searchProvider.search(query, {
        maxResults,
        timeRange,
        language,
        categories,
        engines,
        preferredSites,
      });
      if (caller.kind === 'anon') await consumeQuota(caller, 1);
      else recordUsage(caller.keyId, 'web_search', true);
      res.json({
        query,
        count: results.length,
        results,
        ...(results.length === 0 ? { hint: buildEmptyHint(categories, engines) } : {}),
      });
    } catch (err) {
      logger.warn({ err, query }, '公开搜索失败');
      if (caller.kind === 'key') recordUsage(caller.keyId, 'web_search', false);
      errorJson(res, 502, 'SEARCH_FAILED', `搜索失败: ${errMessage(err)}`);
    }
  });

  router.post('/fetch', async (req, res) => {
    const caller = await resolveCaller(req, res, keyStore);
    if (!caller) return;

    const parsed = fetchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      errorJson(res, 400, 'BAD_REQUEST', `请求参数不合法: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
      return;
    }
    const { url, render } = parsed.data;

    try {
      const outcome = render === 'auto' ? await fetchWithAutoRender(url) : plainOutcome(await fetchPageDetailed(url));
      const cost = outcome.renderedBy === 'browser' ? config.PUBLIC_API_RENDER_COST : 1;
      if (caller.kind === 'anon') await consumeQuota(caller, cost);
      else recordUsage(caller.keyId, outcome.renderedBy === 'browser' ? 'web_fetch_render' : 'web_fetch', true);
      res.json(outcome);
    } catch (err) {
      if (caller.kind === 'key') {
        recordUsage(caller.keyId, render === 'auto' ? 'web_fetch_render' : 'web_fetch', false);
      }
      if (err instanceof SsrfError) {
        errorJson(res, 403, 'FETCH_SSRF_BLOCKED', err.message);
        return;
      }
      if (err instanceof FetchError) {
        res.status(502).json({
          error: { code: 'FETCH_FAILED', kind: err.code, upstreamStatus: err.statusCode, message: err.message },
        });
        return;
      }
      errorJson(res, 502, 'FETCH_FAILED', errMessage(err));
    }
  });

  return router;
}
