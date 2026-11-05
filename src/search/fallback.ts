import { searchProvider } from './searxng.js';
import type { SearchAttempt, SearchOptions, SearchOutcome } from './provider.js';
import { runCommercialFallback } from './commercial/manager.js';
import { logger } from '../utils/logger.js';

/**
 * 搜索路径选择。2026-11 起两者语义趋同，均「云端优先、本地兜底」：
 * - auto（默认）：云端引擎列表 → 未命中 → SearXNG 降级链
 * - cloud：同 auto，历史兼容别名（服务端统一编排后无需区分）
 * 唯一跳过云端的信号是显式传 engines（调用方点名要 SearXNG 某个引擎）。
 */
export type SearchProviderMode = 'auto' | 'cloud';

/**
 * SearXNG 降级链（原 searchWithFallback 主体，逻辑不变）：空结果不是终点，
 * 而是逐级放宽参数再试的信号：
 *
 *   1. 原参数
 *   2. 若显式传了 language → 去掉 language（zh-CN 等显式语言在部分引擎上收窄召回）
 *   3. 若显式传了非 general 的 categories → 去掉 categories（分类引擎可能整体无响应）
 *   4. 引擎收窄到 bing,google（searx.space 公开实例实测错误率最低的两大引擎）
 *
 * 设计依据：2026-09 对 543 次真实调用的分析显示，空结果后把重试责任全部推给调用方，
 * 模型只能瞎改 query（46/109 次重搜仍空）。确定性降级在服务端做完，调用方拿到的
 * 空结果就是「已尽力」的空结果，诊断信息里写明做过什么。
 *
 * 任何一步拿到结果即返回；单步抛错视为该步 0 条继续降级（错误记入诊断）；
 * 全部抛错才向上抛（由调用方转为 isError）。
 */
async function searxngChain(query: string, options: SearchOptions): Promise<SearchOutcome> {
  const variants: { label: string; opts: SearchOptions }[] = [{ label: '原参数', opts: options }];
  if (options.language) {
    variants.push({ label: '去掉 language', opts: { ...options, language: undefined } });
  }
  if (options.categories && options.categories !== 'general') {
    variants.push({ label: '去掉 categories', opts: { ...options, categories: undefined } });
  }
  variants.push({
    label: 'engines=bing,google',
    opts: { ...options, language: undefined, categories: undefined, engines: 'bing,google' },
  });

  const attempts: SearchAttempt[] = [];
  const unresponsive = new Set<string>();
  let lastError: unknown;
  let errorCount = 0;

  for (const { label, opts } of variants) {
    let outcome: SearchOutcome;
    try {
      outcome = await searchProvider.searchDetailed(query, opts);
    } catch (err) {
      errorCount++;
      lastError = err;
      attempts.push({
        label,
        language: opts.language,
        engines: opts.engines,
        categories: opts.categories,
        resultCount: -1,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    attempts.push(...outcome.diagnostics.attempts);
    for (const e of outcome.diagnostics.unresponsiveEngines) unresponsive.add(e);

    if (outcome.results.length > 0) {
      if (attempts.length > 1) {
        logger.info({ query, step: label, count: outcome.results.length }, '空结果降级重试命中');
      }
      return {
        results: outcome.results,
        diagnostics: { attempts, unresponsiveEngines: [...unresponsive] },
      };
    }
  }

  if (errorCount === variants.length && lastError) {
    throw lastError;
  }
  return { results: [], diagnostics: { attempts, unresponsiveEngines: [...unresponsive] } };
}

/**
 * 带兜底的统一搜索入口（云端优先，2026-11 反转默认顺序）。
 *
 * 路径编排：
 *   1. 商业云端引擎按后台列表顺序逐个尝试（列表为空 / 全停用 / 凭证不可用时
 *      整段跳过，无网络请求），任一命中即返回。
 *   2. 云端未命中（空结果或请求失败）→ 执行 SearXNG 降级链，任一命中即返回。
 *   3. 两边都空 → 返回空 + 完整诊断（云端尝试在前、本地尝试在后）。
 *   4. 两边都抛错 → 抛出本地链最终错误（调用方拿到的失败与实际执行一致），
 *      云端失败以诊断记录呈现，不单独上抛。
 *
 * 切换条件唯一：云端是否返回结果。不因结果数量少或质量存疑继续调本地。
 * 显式传 engines（点名 SearXNG 引擎）时跳过云端，尊重本地指定。
 */
export async function searchWithFallback(
  query: string,
  options: SearchOptions = {},
  _provider: SearchProviderMode = 'auto',
): Promise<SearchOutcome> {
  // 显式指定 SearXNG 引擎 = 调用方明确要本地路径（google/bing/ddg 等），
  // 云端引擎没有对应概念，直接走本地降级链。provider 参数不影响该判定。
  if (options.engines) {
    return searxngChain(query, options);
  }

  const attempts: SearchAttempt[] = [];

  // 1. 云端优先（auto 与 cloud 同路径；未配置时 manager 无感返回空）
  const cloud = await runCommercialFallback(query, options.maxResults ?? 10);
  attempts.push(...cloud.attempts);
  if (cloud.results.length > 0) {
    return { results: cloud.results, diagnostics: { attempts, unresponsiveEngines: [] } };
  }

  // 2. 云端未命中 → SearXNG 降级链兜底。
  // 本地链全部抛错时向上抛（保持既有语义）；云端尝试并入诊断一并带出。
  const local = await searxngChain(query, options);
  if (local.results.length > 0) {
    logger.info(
      { query, cloudAttempts: cloud.attempts.length, count: local.results.length },
      '云端未命中，本地 SearXNG 兜底命中',
    );
    return {
      results: local.results,
      diagnostics: {
        attempts: [...attempts, ...local.diagnostics.attempts],
        unresponsiveEngines: local.diagnostics.unresponsiveEngines,
      },
    };
  }

  // 3. 两边都空：合并诊断（云端在前）返回空结果
  return {
    results: [],
    diagnostics: {
      attempts: [...attempts, ...local.diagnostics.attempts],
      unresponsiveEngines: local.diagnostics.unresponsiveEngines,
    },
  };
}
