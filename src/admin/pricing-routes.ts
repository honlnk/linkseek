import { Router } from 'express';
import { requireAdmin } from '../auth/session.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * OpenRouter 模型查价代理。
 *
 * 调用 OpenRouter 公开 GET /api/v1/models（含每模型的 per-token 单价），
 * 按 model id 模糊匹配后返回标准化的 ProviderPricing 参考。
 *
 * - 1 小时内存缓存，避免重复请求；
 * - OpenRouter 返回的是 USD/1M token 价格，若全局 CURRENCY≠USD，
 *   用 PRICING_USD_RATE 做一次性折算（仅配置辅助，非运行时汇率系统）。
 */
export function createPricingRouter(): Router {
  const router = Router();
  router.use(requireAdmin);

  /** 单条模型价格（来自 OpenRouter，已转为每百万 token） */
  interface OpenRouterPricing {
    inputPerMTok: number;
    outputPerMTok: number;
    cacheHitPerMTok: number;
    cacheWritePerMTok: number;
    hasCacheHit: boolean;
    hasCacheWrite: boolean;
  }

  /** 缓存的上游模型列表 */
  type ModelCache = { data: Array<{ id: string; pricing?: Record<string, string> }>; ts: number };
  let cache: ModelCache | null = null;
  const CACHE_TTL = 60 * 60 * 1000; // 1 小时

  /** 拉取并缓存 OpenRouter 模型列表 */
  async function getModelList(): Promise<ModelCache> {
    if (cache && Date.now() - cache.ts < CACHE_TTL) return cache;
    const resp = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'User-Agent': 'linkseek/1.0' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`OpenRouter ${resp.status}`);
    const json = (await resp.json()) as { data?: Array<{ id: string; pricing?: Record<string, string> }> };
    cache = { data: json.data ?? [], ts: Date.now() };
    return cache;
  }

  /**
   * 把 OpenRouter 的 per-token 价格字符串（如 "0.00000027"）转为每百万 token。
   * 无效值返回 0。
   */
  function perTokenToPerMTok(val: string | undefined): number {
    const n = Number(val);
    return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : 0;
  }

  /** 模型 id 规范化：去日期后缀（如 -0731）、去变体后缀用于模糊匹配 */
  function normalizeId(id: string): string {
    return id.toLowerCase().replace(/-(\d{4})$/g, '').replace(/:(free|batch|nitro)$/g, '');
  }

  /** GET /api/pricing/:modelId —— 查询单个模型的参考价 */
  router.get('/:modelId', async (req, res) => {
    const requested = String(req.params.modelId).trim();
    if (!requested) {
      res.status(400).json({ error: '缺少 modelId' });
      return;
    }
    try {
      const { data } = await getModelList();
      const target = normalizeId(requested);
      // 精确匹配优先；其次按规范化 id 匹配；优先非 :free/:batch 变体
      let hit = data.find((m) => m.id === requested)
        ?? data.find((m) => normalizeId(m.id) === target)
        ?? data.find((m) => normalizeId(m.id) === target && !/:(free|batch)/.test(m.id));

      if (!hit || !hit.pricing) {
        res.json({ found: false });
        return;
      }

      const inputPerMTok = perTokenToPerMTok(hit.pricing.prompt);
      const outputPerMTok = perTokenToPerMTok(hit.pricing.completion);
      let cacheHitPerMTok = perTokenToPerMTok(hit.pricing.prompt_cache_read);
      let cacheWritePerMTok = perTokenToPerMTok(hit.pricing.prompt_cache_write);
      const hasCacheHit = cacheHitPerMTok > 0;
      const hasCacheWrite = cacheWritePerMTok > 0;

      // 币种折算：OpenRouter 返回 USD；若全局非 USD，用固定汇率一次性折算（仅参考）
      if (config.CURRENCY !== 'USD') {
        const rate = config.PRICING_USD_RATE;
        const conv = (n: number) => Math.round(n * rate * 10000) / 10000;
        const r: OpenRouterPricing = {
          inputPerMTok: conv(inputPerMTok),
          outputPerMTok: conv(outputPerMTok),
          cacheHitPerMTok: conv(cacheHitPerMTok),
          cacheWritePerMTok: conv(cacheWritePerMTok),
          hasCacheHit,
          hasCacheWrite,
        };
        res.json({ found: true, pricing: r, currency: config.CURRENCY, source: 'openrouter(折算)' });
        return;
      }

      const r: OpenRouterPricing = {
        inputPerMTok,
        outputPerMTok,
        cacheHitPerMTok,
        cacheWritePerMTok,
        hasCacheHit,
        hasCacheWrite,
      };
      res.json({ found: true, pricing: r, currency: 'USD', source: 'openrouter' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message, modelId: requested }, 'OpenRouter 查价失败');
      res.json({ found: false });
    }
  });

  return router;
}
