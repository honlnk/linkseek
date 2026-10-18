import { fetch } from 'undici';
import { fetchDispatcher } from '../../fetch/dispatcher.js';
import { getSetting } from '../../lib/settings.js';
import { logger } from '../../utils/logger.js';
import type { SearchResult } from '../provider.js';
import type { CommercialEngine, CommercialEngineStatus } from './types.js';

/**
 * Brave Search API 引擎（正规商业搜索，免费额度 2000 次/月，
 * Key 在 https://api-dashboard.search.brave.com/ 申请，管理后台「搜索兜底」页填写）。
 */

export const SETTING_KEY_BRAVE_API_KEY = 'braveSearchApiKey';

const DEFAULT_BASE_URL = 'https://api.search.brave.com';
/** Brave 单页上限 20 条 */
const MAX_COUNT = 20;

/** 测试注入用的最小 fetcher 形状 */
export interface BraveFetcher {
  (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

const defaultFetcher: BraveFetcher = (url, init) =>
  fetch(url, { ...init, redirect: 'error', dispatcher: fetchDispatcher });

export interface BraveEngineOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: BraveFetcher;
  getApiKey?: () => Promise<string | null>;
}

interface BraveResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  text?: unknown;
}

export class BraveEngine implements CommercialEngine {
  readonly id = 'brave';
  readonly name = 'Brave Search';

  /** 熔断标记：鉴权被拒后置位，后台重新保存 Key 时清除 */
  private invalidated = false;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: BraveFetcher;
  private readonly getApiKey: () => Promise<string | null>;

  constructor(opts: BraveEngineOptions = {}) {
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
    // Brave Key 无过期时间可解析，只有 未配置/正常/失效 三种状态
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

    const count = Math.min(MAX_COUNT, Math.max(1, Math.trunc(maxResults) || 10));
    const url = `${this.baseUrl}/res/v1/web/search?${new URLSearchParams({ q, count: String(count) })}`;
    const response = await this.fetcher(url, {
      headers: { accept: 'application/json', 'x-subscription-token': key },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.status === 401 || response.status === 403) {
      this.invalidated = true;
      logger.warn({ engine: this.id }, 'Brave API Key 鉴权被拒，已熔断；请在后台重新保存 Key');
      throw new Error('Brave API Key 无效或已过期（鉴权被拒），已熔断，请重新配置');
    }
    if (!response.ok) {
      throw new Error(`Brave 搜索失败（HTTP ${response.status}）`);
    }

    const data = (await response.json()) as { web?: { results?: unknown } } | null;
    const rows = data?.web?.results;
    if (!Array.isArray(rows)) return [];

    const results: SearchResult[] = [];
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const row = raw as BraveResult;
      const url = typeof row.url === 'string' ? row.url.trim() : '';
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
      } catch {
        continue;
      }
      const title = typeof row.title === 'string' ? row.title.trim() : '';
      if (!title) continue;
      const snippet =
        (typeof row.description === 'string' && row.description.trim()) ||
        (typeof row.text === 'string' ? row.text.trim() : '');
      results.push({ title, url, snippet, engines: ['commercial:brave'] });
      if (results.length >= count) break;
    }
    return results;
  }
}

async function readStoredKey(): Promise<string | null> {
  return getSetting(SETTING_KEY_BRAVE_API_KEY);
}

/** 进程内单例 */
export const braveEngine = new BraveEngine();
