import { Router } from 'express';
import { requireAdmin } from '../auth/session.js';
import { logger } from '../utils/logger.js';
import {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  setDefaultProvider,
  fetchAndCacheModels,
} from '../llm/provider-store.js';
import type { Protocol } from '../llm/types.js';

const VALID_PROTOCOLS: Protocol[] = ['openai', 'openai-responses', 'anthropic', 'gemini'];

export function createLlmProviderRouter(): Router {
  const router = Router();

  // 以下所有路由都需管理员登录
  router.use(requireAdmin);

  /** GET /api/llm-providers —— Provider 列表（apiKey 掩码）+ defaultId */
  router.get('/', async (_req, res) => {
    const providers = await listProviders();
    const defaultProvider = providers.find((p) => p.isDefault);
    res.json({ providers, defaultId: defaultProvider?.id ?? null });
  });

  /** POST /api/llm-providers —— 创建 Provider */
  router.post('/', async (req, res) => {
    const { name, protocol, baseUrl, apiKey, model, isDefault } = req.body as {
      name?: string;
      protocol?: string;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      isDefault?: boolean;
    };

    if (!name?.trim()) {
      res.status(400).json({ error: '请输入 Provider 名称' });
      return;
    }
    if (!protocol || !VALID_PROTOCOLS.includes(protocol as Protocol)) {
      res.status(400).json({ error: `协议必须是: ${VALID_PROTOCOLS.join(', ')}` });
      return;
    }
    if (!baseUrl?.trim()) {
      res.status(400).json({ error: '请输入 API Base URL' });
      return;
    }
    if (!apiKey?.trim()) {
      res.status(400).json({ error: '请输入 API Key' });
      return;
    }
    if (!model?.trim()) {
      res.status(400).json({ error: '请输入模型名' });
      return;
    }

    try {
      const provider = await createProvider({
        name: name.trim(),
        protocol: protocol as Protocol,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        model: model.trim(),
        isDefault,
      });
      logger.info({ providerId: provider.id, name: provider.name }, '创建 LLM Provider');
      res.status(201).json({ id: provider.id, name: provider.name });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /** PATCH /api/llm-providers/:id —— 更新 Provider（空 apiKey = 不改） */
  router.patch('/:id', async (req, res) => {
    const { name, protocol, baseUrl, apiKey, model, enabled, isDefault } = req.body as {
      name?: string;
      protocol?: string;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      enabled?: boolean;
      isDefault?: boolean;
    };

    if (protocol !== undefined && !VALID_PROTOCOLS.includes(protocol as Protocol)) {
      res.status(400).json({ error: `协议必须是: ${VALID_PROTOCOLS.join(', ')}` });
      return;
    }

    try {
      const provider = await updateProvider(req.params.id, {
        name,
        protocol: protocol as Protocol | undefined,
        baseUrl,
        apiKey,
        model,
        enabled,
        isDefault,
      });
      res.json({ id: provider.id, name: provider.name });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /** DELETE /api/llm-providers/:id —— 删除 Provider（拒绝默认） */
  router.delete('/:id', async (req, res) => {
    try {
      await deleteProvider(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /** PUT /api/llm-providers/default/:id —— 设默认 Provider */
  router.put('/default/:id', async (req, res) => {
    try {
      await setDefaultProvider(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /** POST /api/llm-providers/:id/models —— 用已保存凭据拉取上游模型列表 */
  router.post('/:id/models', async (req, res) => {
    try {
      const models = await fetchAndCacheModels(req.params.id);
      res.json({ models });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes('401') || message.includes('403') ? 502 : 500;
      res.status(status).json({
        error: `${message}${status === 502 ? '（API Key 无效或权限不足）' : ''}`,
      });
    }
  });

  /** POST /api/llm-providers/models —— 用临时凭据拉取模型列表（新建时预览） */
  router.post('/models', async (req, res) => {
    const { baseUrl, apiKey, protocol } = req.body as {
      baseUrl?: string;
      apiKey?: string;
      protocol?: string;
    };

    if (!baseUrl?.trim() || !apiKey?.trim() || !protocol) {
      res.status(400).json({ error: '需要提供 baseUrl、apiKey、protocol' });
      return;
    }
    if (!VALID_PROTOCOLS.includes(protocol as Protocol)) {
      res.status(400).json({ error: `协议必须是: ${VALID_PROTOCOLS.join(', ')}` });
      return;
    }

    try {
      const models = await fetchAndCacheModels('', {
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        protocol: protocol as Protocol,
      });
      res.json({ models });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes('401') || message.includes('403') ? 502 : 500;
      res.status(status).json({
        error: `${message}${status === 502 ? '（API Key 无效或权限不足）' : ''}`,
      });
    }
  });

  return router;
}
