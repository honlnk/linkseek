import { Router } from 'express';
import { requireAdmin } from '../auth/session.js';
import {
  getTaskConcurrency,
  setSetting,
  SETTING_KEY_TASK_PER_KEY,
  SETTING_KEY_TASK_GLOBAL,
  DEFAULT_TASK_CONCURRENCY_PER_KEY,
  DEFAULT_TASK_CONCURRENCY_GLOBAL,
} from '../lib/settings.js';

/**
 * 任务系统设置（管理台「任务设置」页的后端）。
 *
 * 读写 SystemSetting 的并发上限配置；保存后即时生效——
 * TaskManager 每次调度现读配置，无需重启或通知。
 */
export function createSettingsRouter(): Router {
  const router = Router();
  router.use(requireAdmin);

  /** GET /api/settings/tasks —— 当前任务并发配置（未配置时返回默认值） */
  router.get('/tasks', async (_req, res) => {
    const limits = await getTaskConcurrency();
    res.json({
      perKey: limits.perKey,
      global: limits.global,
      defaults: {
        perKey: DEFAULT_TASK_CONCURRENCY_PER_KEY,
        global: DEFAULT_TASK_CONCURRENCY_GLOBAL,
      },
    });
  });

  /** PUT /api/settings/tasks —— 更新并发配置（部分更新；≥1 整数；保存即生效） */
  router.put('/tasks', async (req, res) => {
    const body = req.body as { perKey?: unknown; global?: unknown };
    const parse = (v: unknown): number | null => {
      const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
      return Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null;
    };

    const perKey = body.perKey !== undefined ? parse(body.perKey) : undefined;
    const global = body.global !== undefined ? parse(body.global) : undefined;
    if (perKey === null || global === null) {
      res.status(400).json({ error: '并发上限必须是 ≥1 的整数（上限 1000）' });
      return;
    }

    if (perKey !== undefined) await setSetting(SETTING_KEY_TASK_PER_KEY, String(perKey));
    if (global !== undefined) await setSetting(SETTING_KEY_TASK_GLOBAL, String(global));

    const limits = await getTaskConcurrency();
    res.json({ perKey: limits.perKey, global: limits.global });
  });

  return router;
}
