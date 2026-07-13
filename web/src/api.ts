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
  totalKeys: number;
  byTool: { tool: string; count: number }[];
  trend: { date: string; counts: Record<string, number> }[];
}

export interface KeyStats {
  key: { id: string; name: string };
  total: number;
  byTool: { tool: string; count: number }[];
  trend: { date: string; counts: Record<string, number> }[];
}
