import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAdmin } from '../auth/session.js';
import { config } from '../config.js';

/**
 * 把 Date 转成 YYYY-MM-DD（UTC）。
 * 全程统一用 UTC 日期做分桶和边界，避免 setHours（本地时区 0 点）
 * 和 toISOString（UTC）混用导致日期错位。
 */
function toUTCDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 生成从 startDate 到 endDate（含）的连续 UTC 日期键数组。
 * 用于补齐趋势图里没有调用的日期，确保"今天"总是出现在图表末尾。
 */
function fillDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const d = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (d <= end) {
    dates.push(toUTCDateKey(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

/**
 * 把 Date 转成小时桶键 YYYY-MM-DDTHH:00（UTC）。
 * 与日期键一样全程 UTC，用于"当天/本周"的细粒度趋势。
 */
function toUTCHourKey(d: Date): string {
  return d.toISOString().slice(0, 13) + ':00';
}

/**
 * 生成从 startHour 到 endHour（含）的连续 UTC 小时桶键数组。
 * 精确到小时，用于补齐"当天/本周"趋势中无调用的时段。
 */
function fillHourRange(startHour: Date, endHour: Date): string[] {
  const hours: string[] = [];
  const d = new Date(startHour);
  const end = new Date(endHour);
  while (d <= end) {
    hours.push(toUTCHourKey(d));
    d.setUTCHours(d.getUTCHours() + 1);
  }
  return hours;
}

export function createStatsRouter(): Router {
  const router = Router();
  router.use(requireAdmin);

  /**
   * GET /api/stats/overview —— 全局统计总览
   * 返回：总请求数、各工具请求数、活跃 Key 数、近 N 天每日趋势
   *
   * query:
   *   days   - 趋势回溯天数（默认 7，上限 90）
   *   bucket - 趋势分桶粒度：'day'（默认）| 'hour'。
   *            'hour' 适合较短的范围（当天/本周），生成按小时分布的细粒度趋势。
   */
  router.get('/overview', async (req, res) => {
    const days = Math.min(Number(req.query.days) || 7, 90);
    const bucket = req.query.bucket === 'hour' ? 'hour' : 'day' as const;

    // 全历史口径：总请求数、各工具分布、已启用 Key 数、Key 总数、AI token/成本总计
    const [total, byTool, enabledKeys, totalKeys, aiAgg] = await Promise.all([
      prisma.usageLog.count(),
      prisma.usageLog.groupBy({
        by: ['toolName'],
        _count: { _all: true },
      }),
      prisma.apiKey.count({ where: { enabled: true } }),
      prisma.apiKey.count(),
      prisma.usageLog.aggregate({
        _sum: {
          promptTokens: true,
          completionTokens: true,
          cacheHitTokens: true,
          cost: true,
        },
      }),
    ]);

    // 近 N 天用量趋势，全程用 UTC 避免时区错位
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    since.setUTCHours(0, 0, 0, 0);

    const logs = await prisma.usageLog.findMany({
      where: { createdAt: { gte: since } },
      select: {
        toolName: true,
        createdAt: true,
        keyId: true,
        promptTokens: true,
        completionTokens: true,
        cacheHitTokens: true,
        cost: true,
      },
    });

    // 活跃 Key：选定窗口内有过调用的不同 keyId 数量（随时间范围变化）
    const activeKeys = new Set(logs.map((l) => l.keyId)).size;

    // 聚合成 { bucketKey: { tool: count } }，并按桶累加 cost
    const trend: Record<string, Record<string, number>> = {};
    const trendCost: Record<string, number> = {};
    const toKey = bucket === 'hour' ? toUTCHourKey : toUTCDateKey;
    for (const log of logs) {
      const key = toKey(log.createdAt);
      if (!trend[key]) trend[key] = {};
      trend[key][log.toolName] = (trend[key][log.toolName] ?? 0) + 1;
      trendCost[key] = (trendCost[key] ?? 0) + log.cost;
    }

    // 补齐缺失的桶，确保趋势图连续（含今天/当前小时）
    if (bucket === 'hour') {
      const nowHour = new Date();
      const allKeys = fillHourRange(since, nowHour);
      for (const k of allKeys) {
        if (!trend[k]) trend[k] = {};
        if (!(k in trendCost)) trendCost[k] = 0;
      }
    } else {
      const todayKey = toUTCDateKey(new Date());
      const sinceKey = toUTCDateKey(since);
      const allDates = fillDateRange(sinceKey, todayKey);
      for (const d of allDates) {
        if (!trend[d]) trend[d] = {};
        if (!(d in trendCost)) trendCost[d] = 0;
      }
    }

    res.json({
      total,
      activeKeys,
      enabledKeys,
      totalKeys,
      byTool: byTool.map((t) => ({ tool: t.toolName, count: t._count._all })),
      // AI 用量与成本（全历史累计）
      ai: {
        promptTokens: aiAgg._sum.promptTokens ?? 0,
        completionTokens: aiAgg._sum.completionTokens ?? 0,
        cacheHitTokens: aiAgg._sum.cacheHitTokens ?? 0,
        cost: aiAgg._sum.cost ?? 0,
      },
      trend: Object.entries(trend)
        .map(([date, counts]) => ({ date, counts, cost: trendCost[date] ?? 0 }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      currency: config.CURRENCY,
    });
  });

  /**
   * GET /api/stats/top-keys —— Key 调用次数排名（降序）
   * 返回近 N 天内调用次数最高的 limit 个 Key，用于后台横向柱状图。
   */
  router.get('/top-keys', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const days = Math.min(Number(req.query.days) || 30, 90);

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    since.setUTCHours(0, 0, 0, 0);

    // 按 keyId 聚合调用次数。
    // 注意：本项目的 Prisma 生成的 CountOrderByAggregateInput 不含 _all 字段，
    // 无法用 orderBy: { _count: { _all: 'desc' } } 排序，故拿全量后在代码里降序截断。
    const grouped = await prisma.usageLog.groupBy({
      by: ['keyId'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });

    if (grouped.length === 0) {
      res.json({ items: [] });
      return;
    }

    // 代码层降序 + 截断 top limit
    const sorted = grouped
      .map((g) => ({ keyId: g.keyId, count: g._count._all }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    // 批量取 Key 名称（已删除的 Key 也能保留其历史用量）
    const keys = await prisma.apiKey.findMany({
      where: { id: { in: sorted.map((g) => g.keyId) } },
      select: { id: true, name: true },
    });
    const nameMap = new Map(keys.map((k) => [k.id, k.name]));

    res.json({
      items: sorted.map((g) => ({
        keyId: g.keyId,
        name: nameMap.get(g.keyId) ?? '(已删除)',
        count: g.count,
      })),
    });
  });

  /**
   * GET /api/stats/keys/:id —— 单个 Key 的用量趋势
   */
  router.get('/keys/:id', async (req, res) => {
    const days = Math.min(Number(req.query.days) || 7, 90);
    const key = await prisma.apiKey.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true },
    });
    if (!key) {
      res.status(404).json({ error: 'Key 不存在' });
      return;
    }

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    since.setUTCHours(0, 0, 0, 0);

    const [total, byTool, daily] = await Promise.all([
      prisma.usageLog.count({ where: { keyId: key.id } }),
      prisma.usageLog.groupBy({
        by: ['toolName'],
        where: { keyId: key.id },
        _count: { _all: true },
      }),
      prisma.usageLog.findMany({
        where: { keyId: key.id, createdAt: { gte: since } },
        select: { toolName: true, createdAt: true },
      }),
    ]);

    const trend: Record<string, Record<string, number>> = {};
    for (const log of daily) {
      const dateKey = toUTCDateKey(log.createdAt);
      if (!trend[dateKey]) trend[dateKey] = {};
      trend[dateKey][log.toolName] = (trend[dateKey][log.toolName] ?? 0) + 1;
    }

    // 补齐缺失的日期
    const todayKey = toUTCDateKey(new Date());
    const sinceKey = toUTCDateKey(since);
    const allDates = fillDateRange(sinceKey, todayKey);
    for (const d of allDates) {
      if (!trend[d]) trend[d] = {};
    }

    res.json({
      key,
      total,
      byTool: byTool.map((t) => ({ tool: t.toolName, count: t._count._all })),
      trend: Object.entries(trend)
        .map(([date, counts]) => ({ date, counts }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    });
  });

  return router;
}
