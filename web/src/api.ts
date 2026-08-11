/**
 * 后端 API 封装。
 * 401 时自动跳转登录页。
 */

const headers = { 'Content-Type': 'application/json' };

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, { ...options, headers: { ...headers, ...options.headers } });
  if (res.status === 401) {
    // 未登录或会话过期，跳转登录
    window.location.hash = '';
    window.location.href = '/login';
    throw new Error('未登录');
  }
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return data as T;
}

/** 检查登录状态 */
export async function checkLogin(): Promise<boolean> {
  try {
    await api('/me');
    return true;
  } catch {
    return false;
  }
}

// ---- 类型 ----

export interface ApiKeyItem {
  id: string;
  name: string;
  tokenPrefix: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: { usages: number };
}

export interface OverviewStats {
  total: number;
  activeKeys: number;
  enabledKeys: number;
  totalKeys: number;
  byTool: { tool: string; count: number }[];
  /** AI 用量与成本（全历史累计） */
  ai: {
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    cost: number;
  };
  trend: { date: string; counts: Record<string, number>; cost: number }[];
  /** 展示货币代码（用于金额符号） */
  currency: string;
}

export interface KeyStats {
  key: { id: string; name: string };
  total: number;
  byTool: { tool: string; count: number }[];
  trend: { date: string; counts: Record<string, number> }[];
}

export interface TopKeyItem {
  keyId: string;
  name: string;
  count: number;
}

export interface TopKeysResp {
  items: TopKeyItem[];
}

// ---- LLM Provider ----

export type Protocol = 'openai' | 'openai-responses' | 'anthropic' | 'gemini';

/** Provider 价格配置（单一货币，不含 currency 字段） */
export interface ProviderPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheHitEnabled: boolean;
  cacheHitPerMTok: number;
  cacheWriteEnabled: boolean;
  cacheWritePerMTok: number;
}

export interface LlmProviderItem {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKeyMasked: string;
  model: string;
  models: string[];
  enabled: boolean;
  isDefault: boolean;
  pricing: ProviderPricing;
  createdAt: string;
  updatedAt: string;
}

export interface LlmProviderList {
  providers: LlmProviderItem[];
  defaultId: string | null;
}
