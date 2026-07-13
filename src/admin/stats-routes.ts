import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAdmin } from '../auth/session.js';

export function createStatsRouter(): Router {
  const router = Router();
  router.use(requireAdmin);

  /**
   * GET /api/stats/overview —— 全局统计总览
   * 返回：总请求数、各工具请求数、活跃 Key 数、近 N 天每日趋势
   */
  router.get('/overview', async (req, res) => {
    const days = Math.min(Number(req.query.days) || 7, 90);

    const [total, byTool, activeKeys, totalKeys] = await Promise.all([
      prisma.usageLog.count(),
      prisma.usageLog.groupBy({
        by: ['toolName'],
        _count: { _all: true },
      }),
      prisma.apiKey.count({ where: { enabled: true } }),
      prisma.apiKey.count(),
    ]);

    // 近 N 天每日用量趋势（按工具分组）
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const daily = await prisma.usageLog.findMany({
      where: { createdAt: { gte: since } },
      select: { toolName: true, createdAt: true },
    });

    // 聚合成 { date: { tool: count } }
    const trend: Record<string, Record<string, number>> = {};
    for (const log of daily) {
      const dateKey = log.createdAt.toISOString().slice(0, 10); // YYYY-MM-DD
      if (!trend[dateKey]) trend[dateKey] = {};
      trend[dateKey][log.toolName] = (trend[dateKey][log.toolName] ?? 0) + 1;
    }

    res.json({
      total,
      activeKeys,
      totalKeys,
      byTool: byTool.map((t) => ({ tool: t.toolName, count: t._count._all })),
      trend: Object.entries(trend)
        .map(([date, counts]) => ({ date, counts }))
        .sort((a, b) => a.date.localeCompare(b.date)),
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
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

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
      const dateKey = log.createdAt.toISOString().slice(0, 10);
      if (!trend[dateKey]) trend[dateKey] = {};
      trend[dateKey][log.toolName] = (trend[dateKey][log.toolName] ?? 0) + 1;
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
