import { fetch } from 'undici';
import { fetchDispatcher } from '../../fetch/dispatcher.js';
import { getSetting } from '../../lib/settings.js';
import { logger } from '../../utils/logger.js';
import type { SearchResult } from '../provider.js';
import type { CommercialEngine, CommercialEngineStatus } from './types.js';

/**
 * DeepSeek Search API 引擎（POST {base}/v1/tools/search）。
 * API Key 在 https://platform.deepseek.com/ 申请，平台余额扣费（人民币充值，
 * 无需国际信用卡）；按成功请求计费（$0.75/千次，失败请求不扣费）。
 * 请求契约对齐 deepseek-harness 的 dsh-web-deepseek-api 参考实现。
 */

export const SETTING_KEY_DEEPSEEK_API_KEY = 'deepseekApiKey';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1/tools';
/** DeepSeek count 上限（官方文档：1-50） */
const MAX_COUNT = 50;

/** 测试注入用的最小 fetcher 形状 */
export interface DeepSeekFetcher {
  (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal; body?: string }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

const defaultFetcher: DeepSeekFetcher = (url, init) =>
  fetch(url, { method: 'POST', ...init, redirect: 'error', dispatcher: fetchDispatcher });

export interface DeepSeekEngineOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: DeepSeekFetcher;
  getApiKey?: () => Promise<string | null>;
}

interface DeepSeekResult {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  date?: unknown;
}

export class DeepSeekEngine implements CommercialEngine {
  readonly id = 'deepseek';
  readonly name = 'DeepSeek 搜索';

  /** 熔断标记：鉴权被拒后置位，后台重新保存 Key 时清除 */
  private invalidated = false;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: DeepSeekFetcher;
  private readonly getApiKey: () => Promise<string | null>;

  constructor(opts: DeepSeekEngineOptions = {}) {
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
    // DeepSeek Key 无过期时间可解析，只有 未配置/正常/失效 三种状态
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
    const response = await this.fetcher(`${this.baseUrl.replace(/\/+$/, '')}/search`, {
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({ query: q, count, need_content: false }),
    });

    if (response.status === 401 || response.status === 403) {
      this.invalidated = true;
      logger.warn({ engine: this.id }, 'DeepSeek API Key 鉴权被拒，已熔断；请在后台重新保存 Key');
      throw new Error('DeepSeek API Key 无效或已过期（鉴权被拒），已熔断，请重新配置');
    }
    if (!response.ok) {
      throw new Error(`DeepSeek 搜索失败（HTTP ${response.status}）`);
    }

    const data = (await response.json()) as { results?: unknown } | null;
    const rows = data?.results;
    if (!Array.isArray(rows)) return [];

    const results: SearchResult[] = [];
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const row = raw as DeepSeekResult;
      const url = typeof row.url === 'string' ? row.url.trim() : '';
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
      } catch {
        continue;
      }
      const title = typeof row.title === 'string' ? row.title.trim() : '';
      if (!title) continue;
      const snippet = typeof row.snippet === 'string' ? row.snippet.trim() : '';
      results.push({ title, url, snippet, engines: ['commercial:deepseek'] });
      if (results.length >= count) break;
    }
    return results;
  }
}

async function readStoredKey(): Promise<string | null> {
  return getSetting(SETTING_KEY_DEEPSEEK_API_KEY);
}

/** 进程内单例 */
export const deepseekEngine = new DeepSeekEngine();
