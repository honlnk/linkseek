import { Router } from 'express';
import { requireAdmin } from '../auth/session.js';
import {
  getSetting,
  getTaskConcurrency,
  setSetting,
  deleteSetting,
  SETTING_KEY_TASK_PER_KEY,
  SETTING_KEY_TASK_GLOBAL,
  DEFAULT_TASK_CONCURRENCY_PER_KEY,
  DEFAULT_TASK_CONCURRENCY_GLOBAL,
} from '../lib/settings.js';
import {
  beginDevinLogin,
  clearDevinToken,
  completeDevinLogin,
} from '../search/commercial/devin.js';
import { braveEngine, SETTING_KEY_BRAVE_API_KEY } from '../search/commercial/brave.js';
import { exaEngine, SETTING_KEY_EXA_API_KEY } from '../search/commercial/exa.js';
import { deepseekEngine, SETTING_KEY_DEEPSEEK_API_KEY } from '../search/commercial/deepseek.js';
import {
  commercialManager,
  loadEngineEntries,
  saveEngineEntries,
  type CommercialEngineEntry,
} from '../search/commercial/manager.js';
import type { CommercialEngineStatus } from '../search/commercial/types.js';

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

  // ---- 搜索兜底（商业引擎，设计方案 4.3 / 4.6）----

  interface SearchFallbackState {
    engines: CommercialEngineEntry[];
    catalog: Array<{ id: string; name: string; status: CommercialEngineStatus }>;
    brave: { configured: boolean };
    exa: { configured: boolean };
    deepseek: { configured: boolean };
  }

  /** API-Key 型引擎的保存/清除（空串 = 清除；重保存时清熔断标记） */
  async function saveApiKeySetting(
    keyName: string,
    value: string,
    engine: { reset(): void },
  ): Promise<void> {
    if (value) {
      await setSetting(keyName, value);
    } else {
      await deleteSetting(keyName);
    }
    engine.reset();
  }

  async function readSearchFallbackState(): Promise<SearchFallbackState> {
    const [engines, catalog, braveKey, exaKey, deepSeekKey] = await Promise.all([
      loadEngineEntries(),
      commercialManager.catalog(),
      getSetting(SETTING_KEY_BRAVE_API_KEY),
      getSetting(SETTING_KEY_EXA_API_KEY),
      getSetting(SETTING_KEY_DEEPSEEK_API_KEY),
    ]);
    return {
      engines,
      catalog,
      brave: { configured: Boolean(braveKey?.trim()) },
      exa: { configured: Boolean(exaKey?.trim()) },
      deepseek: { configured: Boolean(deepSeekKey?.trim()) },
    };
  }

  /** GET /api/settings/search-fallback —— 引擎列表 + 各引擎状态（token 只回状态，不回明文） */
  router.get('/search-fallback', async (_req, res) => {
    res.json(await readSearchFallbackState());
  });

  /** PUT /api/settings/search-fallback —— 更新引擎列表（顺序即数组顺序）与各引擎 API Key */
  router.put('/search-fallback', async (req, res) => {
    const body = req.body as {
      engines?: unknown;
      braveApiKey?: unknown;
      exaApiKey?: unknown;
      deepseekApiKey?: unknown;
    };
    if (body.engines !== undefined) {
      if (!Array.isArray(body.engines)) {
        res.status(400).json({ error: 'engines 必须是数组' });
        return;
      }
      const entries: CommercialEngineEntry[] = [];
      const seen = new Set<string>();
      for (const item of body.engines) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          res.status(400).json({ error: '引擎条目格式错误（需要 {id, enabled}）' });
          return;
        }
        const { id, enabled } = item as Record<string, unknown>;
        if (typeof id !== 'string' || !commercialManager.has(id)) {
          res.status(400).json({ error: `未知引擎: ${String(id)}` });
          return;
        }
        if (typeof enabled !== 'boolean') {
          res.status(400).json({ error: 'enabled 必须是布尔值' });
          return;
        }
        if (seen.has(id)) {
          res.status(400).json({ error: `引擎重复: ${id}` });
          return;
        }
        seen.add(id);
        entries.push({ id, enabled });
      }
      await saveEngineEntries(entries);
    }
    if (typeof body.braveApiKey === 'string') {
      await saveApiKeySetting(SETTING_KEY_BRAVE_API_KEY, body.braveApiKey.trim(), braveEngine);
    }
    if (typeof body.exaApiKey === 'string') {
      await saveApiKeySetting(SETTING_KEY_EXA_API_KEY, body.exaApiKey.trim(), exaEngine);
    }
    if (typeof body.deepseekApiKey === 'string') {
      await saveApiKeySetting(SETTING_KEY_DEEPSEEK_API_KEY, body.deepseekApiKey.trim(), deepseekEngine);
    }
    res.json(await readSearchFallbackState());
  });

  /** POST /api/settings/search-fallback/devin-login —— 发起粘贴码登录，返回授权 URL */
  router.post('/search-fallback/devin-login', async (_req, res) => {
    try {
      const url = await beginDevinLogin();
      res.json({ url });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** POST /api/settings/search-fallback/devin-exchange —— 用粘贴的授权码换 token 并存储 */
  router.post('/search-fallback/devin-exchange', async (req, res) => {
    const { code } = req.body as { code?: unknown };
    if (typeof code !== 'string' || !code.trim()) {
      res.status(400).json({ error: '请输入授权码' });
      return;
    }
    try {
      const { expiresAt } = await completeDevinLogin(code);
      res.json({ status: 'ok', expiresAt });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** DELETE /api/settings/search-fallback/devin-token —— 注销：清除 token 与熔断标记 */
  router.delete('/search-fallback/devin-token', async (_req, res) => {
    await clearDevinToken();
    res.json({ status: 'ok' });
  });

  return router;
}
