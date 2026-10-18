import { createHash, randomBytes } from 'node:crypto';
import { fetch } from 'undici';
import { fetchDispatcher } from '../../fetch/dispatcher.js';
import { deleteSetting, getSetting, setSetting } from '../../lib/settings.js';
import { logger } from '../../utils/logger.js';
import type { SearchResult } from '../provider.js';
import type { CommercialEngine, CommercialEngineStatus } from './types.js';

/**
 * Devin/Exa 商业搜索引擎（移植自 dsh-devin-search，移植清单见设计方案第三节）。
 *
 * 原理：Devin 账号经「粘贴码 OAuth」换取 session token，以 Windsurf IDE 客户端的
 * 形态调用 Codeium/Windsurf 的 Exa 搜索接口（GetWebSearchResults），免费获得商业级召回。
 * 属于非官方用法（存在 ToS/封号风险），因此严格 opt-in：不配置 token 时整体不参与兜底。
 */

export const SETTING_KEY_DEVIN_TOKEN = 'devinSearchToken';
/** 粘贴码 OAuth 的 verifier 暂存（JSON：{verifier, state, issuedAt}，10 分钟过期，与全局凭证同级存储，多实例友好） */
export const SETTING_KEY_DEVIN_OAUTH_PENDING = 'devinOAuthPending';

const AUTH_BASE = 'https://app.devin.ai';
const TOKEN_URL = 'https://api.devin.ai/auth/cli/token';
/** Windsurf Connect 协议的搜索端点（双 host 故障转移） */
const WEB_PATH = '/exa.api_server_pb.ApiServerService/GetWebSearchResults';
const DEFAULT_HOSTS = ['https://server.codeium.com', 'https://server.self-serve.windsurf.com'];

/** Windsurf metadata.apiKey 要求的 token 形态：裸 JWT 需包装为 devin-session-token$<jwt> */
const SESSION_TOKEN_PREFIX = 'devin-session-token$';
/** 无法从 JWT exp 解析出过期时间时的兜底有效期（与 dsh-devin-search 对齐：365 天） */
const FALLBACK_EXPIRES_MS = 365 * 24 * 60 * 60 * 1000;
/** OAuth verifier 暂存时长 */
const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

/** 测试注入用的最小 fetcher 形状（不耦合 undici 具体类型） */
export interface DevinFetcher {
  (
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

/** 默认 fetcher：走出站代理（境外站点）；禁止跟随重定向，防止凭证经 30x 泄漏给第三方 */
const defaultFetcher: DevinFetcher = (url, init) =>
  fetch(url, { ...init, redirect: 'error', dispatcher: fetchDispatcher });

// ---- token 工具（dsh-devin-search safety.ts 移植） ----

/** 幂等包装：裸 JWT → devin-session-token$…；已带前缀 / sk-ws-* 原样返回 */
export function toDevinSessionToken(token: string): string {
  const raw = token.trim();
  if (!raw || raw.startsWith(SESSION_TOKEN_PREFIX) || raw.startsWith('sk-ws-')) return raw;
  return `${SESSION_TOKEN_PREFIX}${raw}`;
}

/** 解析过期时间：优先 JWT exp（提前 1 分钟视为过期），解析不出走 365 天兜底 */
export function devinTokenExpiry(
  token: string,
  now = Date.now(),
): { expiresAt: number; source: 'jwt' | 'fallback' } {
  try {
    const body = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    if (typeof body.exp === 'number' && Number.isFinite(body.exp) && body.exp > 0) {
      return { expiresAt: body.exp * 1000 - 60_000, source: 'jwt' };
    }
  } catch {
    // 非 JWT 形态（如 sk-ws-*），走兜底有效期
  }
  return { expiresAt: now + FALLBACK_EXPIRES_MS, source: 'fallback' };
}

/** 展开一个 token 的全部线上形态（裸 JWT / 带前缀），均参与脱敏 */
function tokenSecrets(token: string): string[] {
  const raw = token.trim();
  if (!raw) return [];
  const set = new Set([raw, toDevinSessionToken(raw)]);
  if (raw.startsWith(SESSION_TOKEN_PREFIX)) set.add(raw.slice(SESSION_TOKEN_PREFIX.length));
  return [...set].filter(Boolean);
}

/** 脱敏：token 的任何形态出现即替换为 [redacted]（长形态优先替换，避免前缀残留） */
export function redactToken(text: string, token: string): string {
  let out = text;
  for (const secret of tokenSecrets(token).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

// ---- 防御性结果解析（dsh-devin-search web.ts 移植） ----

/** 多键兜底取第一个非空字符串值（上游字段名不稳定） */
function firstString(row: Record<string, unknown>, keys: string[], cap: number): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, cap);
  }
  return '';
}

function parseDevinResults(rows: unknown[], limit: number, token: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const url = firstString(row, ['url', 'sourceUrl', 'webUrl', 'link'], 4096);
    // URL 白名单：只接受 http(s) 且不带 userinfo 的地址
    try {
      const parsed = new URL(url);
      if (
        (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
        parsed.username ||
        parsed.password
      ) {
        continue;
      }
    } catch {
      continue;
    }
    results.push({
      title: redactToken(firstString(row, ['title', 'name', 'webTitle'], 512), token),
      url,
      snippet: redactToken(firstString(row, ['snippet', 'summary', 'text', 'content'], 4096), token),
      engines: ['commercial:devin'],
    });
    if (results.length >= limit) break;
  }
  return results;
}

// ---- 搜索引擎 ----

export interface DevinEngineOptions {
  hosts?: string[];
  timeoutMs?: number;
  fetcher?: DevinFetcher;
  /** 凭证读取（默认 SystemSetting；测试注入） */
  getToken?: () => Promise<string | null>;
}

export class DevinEngine implements CommercialEngine {
  readonly id = 'devin';
  readonly name = 'Devin (Exa)';

  /** 熔断标记：全部 host 鉴权被拒后置位，后续请求直接跳过（后台重新登录/注销时清除） */
  private invalidated = false;
  private readonly hosts: string[];
  private readonly timeoutMs: number;
  private readonly fetcher: DevinFetcher;
  private readonly getToken: () => Promise<string | null>;

  constructor(opts: DevinEngineOptions = {}) {
    this.hosts = opts.hosts ?? DEFAULT_HOSTS;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.getToken = opts.getToken ?? readStoredToken;
  }

  async status(): Promise<CommercialEngineStatus> {
    let token: string | null = null;
    try {
      token = await this.getToken();
    } catch {
      // 配置读取故障不等于凭证失效，按未配置处理
    }
    if (!token || !token.trim()) return { state: 'not_configured' };
    if (this.invalidated) return { state: 'invalid' };
    const { expiresAt } = devinTokenExpiry(token);
    return expiresAt <= Date.now()
      ? { state: 'expired', expiresAt }
      : { state: 'ok', expiresAt };
  }

  async available(): Promise<boolean> {
    return (await this.status()).state === 'ok';
  }

  /** 清除熔断标记（重新登录成功 / 注销时调用） */
  reset(): void {
    this.invalidated = false;
  }

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const q = query.trim();
    if (!q || q.length > 8192) return [];
    const token = (await this.getToken())?.trim();
    if (!token) return [];

    const limit = Math.min(10, Math.max(1, Math.trunc(maxResults) || 5));
    const signal = AbortSignal.timeout(this.timeoutMs);
    let authRejected = 0;
    let hostsTried = 0;

    for (const host of this.hosts) {
      hostsTried++;
      let response: Awaited<ReturnType<DevinFetcher>>;
      try {
        response = await this.fetcher(`${host}${WEB_PATH}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'connect-protocol-version': '1',
            accept: 'application/json',
            'user-agent': 'windsurf/1.9600.41',
          },
          body: JSON.stringify({
            metadata: {
              apiKey: token,
              ideName: 'windsurf',
              ideVersion: '1.9600.41',
              extensionName: 'windsurf',
              extensionVersion: '1.9600.41',
              locale: 'en',
            },
            query: q,
            limit,
          }),
          signal,
        });
      } catch {
        if (signal.aborted) throw new Error(`Devin 搜索超时（${this.timeoutMs}ms）`);
        continue; // 单 host 网络故障：静默换下一个 host
      }
      if (response.status === 401 || response.status === 403) {
        authRejected++;
        continue;
      }
      if (!response.ok) continue;
      const payload = (await response.json()) as { results?: unknown } | null;
      if (!payload || !Array.isArray(payload.results)) {
        throw new Error('Devin 搜索响应格式异常（缺少 results 数组）');
      }
      return parseDevinResults(payload.results, limit, token);
    }

    // 熔断判定：仅当全部 host 都鉴权被拒才判 token 失效；单 host 故障不误杀
    if (hostsTried > 0 && authRejected === hostsTried) {
      this.invalidated = true;
      logger.warn(
        { engine: this.id },
        'Devin token 鉴权被拒（全部 host 401/403），已熔断；请在后台重新登录',
      );
      throw new Error('Devin token 已失效（鉴权被拒），已熔断，请重新登录');
    }
    return [];
  }
}

async function readStoredToken(): Promise<string | null> {
  return getSetting(SETTING_KEY_DEVIN_TOKEN);
}

/** 进程内单例（manager 注册表引用；熔断标记跟随进程生命周期） */
export const devinEngine = new DevinEngine();

// ---- 粘贴码 OAuth（管理后台流程，dsh-devin-search oauthCode 移植） ----

interface DevinOAuthPending {
  verifier: string;
  state: string;
  issuedAt: number;
}

/**
 * 发起登录：生成 PKCE verifier 并暂存到 SystemSetting，返回授权 URL。
 * 管理员浏览器打开 URL → 登录 Devin → 复制授权码 → 粘贴回后台（completeDevinLogin）。
 */
export async function beginDevinLogin(): Promise<string> {
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  await setSetting(
    SETTING_KEY_DEVIN_OAUTH_PENDING,
    JSON.stringify({ verifier, state, issuedAt: Date.now() } satisfies DevinOAuthPending),
  );
  const url = new URL('/auth/cli/continue', AUTH_BASE);
  url.search = new URLSearchParams({
    state,
    prompt: 'select_account',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

/** 用粘贴回的授权码换 token 并存储；成功后清除 verifier 暂存与熔断标记 */
export async function completeDevinLogin(
  code: string,
  fetcher: DevinFetcher = defaultFetcher,
): Promise<{ expiresAt: number }> {
  const pendingRaw = await getSetting(SETTING_KEY_DEVIN_OAUTH_PENDING);
  if (!pendingRaw) {
    throw new Error('没有进行中的 Devin 登录流程，请先点击「登录 Devin」');
  }
  let pending: DevinOAuthPending | undefined;
  try {
    pending = JSON.parse(pendingRaw) as DevinOAuthPending;
  } catch {
    await deleteSetting(SETTING_KEY_DEVIN_OAUTH_PENDING);
    throw new Error('登录流程状态损坏，请重新发起');
  }
  if (
    !pending ||
    typeof pending.verifier !== 'string' ||
    !pending.verifier ||
    typeof pending.issuedAt !== 'number'
  ) {
    await deleteSetting(SETTING_KEY_DEVIN_OAUTH_PENDING);
    throw new Error('登录流程状态损坏，请重新发起');
  }
  if (Date.now() - pending.issuedAt > OAUTH_PENDING_TTL_MS) {
    await deleteSetting(SETTING_KEY_DEVIN_OAUTH_PENDING);
    throw new Error('登录流程已过期（超过 10 分钟），请重新发起');
  }
  const trimmed = code.trim();
  if (!trimmed || trimmed.length > 8192 || /[\s\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error('授权码格式无效');
  }

  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ code: trimmed, code_verifier: pending.verifier }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Devin token 交换失败（HTTP ${response.status}），请重试登录`);
  }
  const data = (await response.json()) as { token?: unknown } | null;
  if (!data || typeof data.token !== 'string' || !data.token) {
    throw new Error('Devin token 交换响应异常（缺少 token），请重试登录');
  }

  const token = toDevinSessionToken(data.token);
  await setSetting(SETTING_KEY_DEVIN_TOKEN, token);
  await deleteSetting(SETTING_KEY_DEVIN_OAUTH_PENDING);
  devinEngine.reset();
  const { expiresAt } = devinTokenExpiry(token);
  logger.info({ expiresAt }, 'Devin 登录成功，token 已存储');
  return { expiresAt };
}

/** 注销：清除 token 与熔断标记 */
export async function clearDevinToken(): Promise<void> {
  await deleteSetting(SETTING_KEY_DEVIN_TOKEN);
  devinEngine.reset();
}
