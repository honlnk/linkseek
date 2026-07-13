import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAdmin } from '../auth/session.js';
import { generateApiKey } from '../auth/key-store.js';
import { logger } from '../utils/logger.js';

export function createKeyRouter(): Router {
  const router = Router();

  // 以下所有路由都需管理员登录
  router.use(requireAdmin);

  /** GET /api/keys —— Key 列表（不含 tokenHash，含用量计数） */
  router.get('/', async (_req, res) => {
    const keys = await prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        enabled: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { usages: true } },
      },
    });
    res.json({ keys });
  });

  /** POST /api/keys —— 创建新 Key（明文仅返回一次） */
  router.post('/', async (req, res) => {
    const { name } = req.body as { name?: string };
    if (!name || name.trim().length === 0) {
      res.status(400).json({ error: '请输入 Key 名称' });
      return;
    }

    const { plaintext, tokenHash, tokenPrefix } = generateApiKey();
    const key = await prisma.apiKey.create({
      data: { name: name.trim(), tokenHash, tokenPrefix },
    });
    logger.info({ keyId: key.id, name: key.name }, '创建新 API Key');
    res.status(201).json({
      id: key.id,
      name: key.name,
      tokenPrefix: key.tokenPrefix,
      key: plaintext, // 明文仅此一次返回
      createdAt: key.createdAt,
    });
  });

  /** GET /api/keys/:id —— 单个 Key 详情 + 用量统计 */
  router.get('/:id', async (req, res) => {
    const key = await prisma.apiKey.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        enabled: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { usages: true } },
      },
    });
    if (!key) {
      res.status(404).json({ error: 'Key 不存在' });
      return;
    }

    // 按工具名聚合用量
    const byTool = await prisma.usageLog.groupBy({
      by: ['toolName'],
      where: { keyId: key.id },
      _count: { _all: true },
    });

    res.json({
      ...key,
      usageByTool: byTool.map((t) => ({ tool: t.toolName, count: t._count._all })),
    });
  });

  /** PATCH /api/keys/:id —— 启停 Key */
  router.patch('/:id', async (req, res) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled 必须是布尔值' });
      return;
    }

    const key = await prisma.apiKey.update({
      where: { id: req.params.id },
      data: { enabled },
      select: { id: true, name: true, enabled: true },
    }).catch(() => null);

    if (!key) {
      res.status(404).json({ error: 'Key 不存在' });
      return;
    }
    logger.info({ keyId: key.id, enabled }, '切换 Key 启停状态');
    res.json(key);
  });

  /** DELETE /api/keys/:id —— 删除 Key（关联的用量记录级联删除） */
  router.delete('/:id', async (req, res) => {
    const key = await prisma.apiKey.delete({
      where: { id: req.params.id },
      select: { id: true, name: true },
    }).catch(() => null);

    if (!key) {
      res.status(404).json({ error: 'Key 不存在' });
      return;
    }
    logger.info({ keyId: key.id, name: key.name }, '删除 API Key');
    res.json({ ok: true });
  });

  return router;
}
