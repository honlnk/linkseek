/**
 * 突发限流：每身份每分钟最多 N 次请求（内存滑动窗口）。
 *
 * 单实例部署够用：linkseek 是单进程服务，重启清零可接受
 * （日配额在 FreeUsage 表里持久化，那才是硬约束）。
 */

const WINDOW_MS = 60_000;

const buckets = new Map<string, number[]>();

/**
 * 判定当前请求是否放行。放行则记录一次命中。
 * 返回 false = 超限，请求应被拒绝（429 RATE_LIMITED）。
 */
export function burstAllow(key: string, maxPerMinute: number): boolean {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= maxPerMinute) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

// 定期清理沉寂键，防 Map 无界增长（unref 不阻碍进程退出）
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of buckets) {
    const alive = hits.filter((t) => now - t < WINDOW_MS);
    if (alive.length === 0) buckets.delete(key);
    else buckets.set(key, alive);
  }
}, WINDOW_MS);
cleanup.unref();
