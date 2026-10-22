import { fetch } from 'undici';
import { fetchDispatcher } from '../../fetch/dispatcher.js';
import { getSetting } from '../../lib/settings.js';
import { logger } from '../../utils/logger.js';
import type { SearchResult } from '../provider.js';
import type { CommercialEngine, CommercialEngineStatus } from './types.js';

/**
 * Exa 官方搜索 API 引擎（POST /search，语义/关键词混合检索）。
 * API Key 在 https://dashboard.exa.ai/ 申请（注册即有免费额度，无需绑卡），
 * 管理后台「搜索兜底」页填写。请求 highlights 内容（每条 1 句摘要），不拉全文。
 */

export const SETTING_KEY_EXA_API_KEY = 'exaApiKey';

const DEFAULT_BASE_URL = 'https://api.exa.ai';
/** Exa numResults 上限（对齐 DeepSeek 官方上限，linkseek 调用方最多 30） */
const MAX_COUNT = 50;

/** 测试注入用的最小 fetcher 形状 */
export interface ExaFetcher {
  (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal; body?: string }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

const defaultFetcher: ExaFetcher = (url, init) =>
  fetch(url, { method: 'POST', ...init, redirect: 'error', dispatcher: fetchDispatcher });

export interface ExaEngineOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: ExaFetcher;
  getApiKey?: () => Promise<string | null>;
}

interface ExaResult {
  title?: unknown;
  url?: unknown;
  highlights?: unknown;
  summary?: unknown;
  text?: unknown;
}

export class ExaEngine implements CommercialEngine {
  readonly id = 'exa';
  readonly name = 'Exa';

  /** 熔断标记：鉴权被拒后置位，后台重新保存 Key 时清除 */
  private invalidated = false;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: ExaFetcher;
  private readonly getApiKey: () => Promise<string | null>;

  constructor(opts: ExaEngineOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.getApiKey = opts.getApiKey ?? readStoredKey;
  }

  async status(): Promise<CommercialEngineStatus> {
    let key: string | null = null;
    try {
      key = await this.getApiKey();
    } catch {
      // 配置读取故障按未配置处理
    }
    if (!key || !key.trim()) return { state: 'not_configured' };
    // Exa Key 无过期时间可解析，只有 未配置/正常/失效 三种状态
    return this.invalidated ? { state: 'invalid' } : { state: 'ok' };
  }

  async available(): Promise<boolean> {
    return (await this.status()).state === 'ok';
  }

  /** 清除熔断标记（后台重新保存 Key 时调用） */
  reset(): void {
    this.invalidated = false;
  }

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const q = query.trim();
    if (!q) return [];
    const key = (await this.getApiKey())?.trim();
    if (!key) return [];

    const numResults = Math.min(MAX_COUNT, Math.max(1, Math.trunc(maxResults) || 10));
    const response = await this.fetcher(`${this.baseUrl}/search`, {
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        query: q,
        type: 'auto',
        contents: { highlights: { highlightsPerUrl: 1 } },
        numResults,
      }),
    });

    if (response.status === 401 || response.status === 403) {
      this.invalidated = true;
      logger.warn({ engine: this.id }, 'Exa API Key 鉴权被拒，已熔断；请在后台重新保存 Key');
      throw new Error('Exa API Key 无效或已过期（鉴权被拒），已熔断，请重新配置');
    }
    if (!response.ok) {
      throw new Error(`Exa 搜索失败（HTTP ${response.status}）`);
    }

    const data = (await response.json()) as { results?: unknown } | null;
    const rows = data?.results;
    if (!Array.isArray(rows)) return [];

    const results: SearchResult[] = [];
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const row = raw as ExaResult;
      const url = typeof row.url === 'string' ? row.url.trim() : '';
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
      } catch {
        continue;
      }
      const title = typeof row.title === 'string' ? row.title.trim() : '';
      if (!title) continue;
      const snippet = firstHighlight(row.highlights) || stringOrEmpty(row.summary) || stringOrEmpty(row.text);
      results.push({ title, url, snippet, engines: ['commercial:exa'] });
      if (results.length >= numResults) break;
    }
    return results;
  }
}

/** 取 highlights 数组里第一句非空摘要 */
function firstHighlight(highlights: unknown): string {
  if (!Array.isArray(highlights)) return '';
  for (const item of highlights) {
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return '';
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function readStoredKey(): Promise<string | null> {
  return getSetting(SETTING_KEY_EXA_API_KEY);
}

/** 进程内单例 */
export const exaEngine = new ExaEngine();
