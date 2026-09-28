import { searchProvider } from './searxng.js';
import type { SearchAttempt, SearchOptions, SearchOutcome } from './provider.js';
import { logger } from '../utils/logger.js';

/**
 * 带降级重试的搜索。空结果不是终点，而是逐级放宽参数再试的信号：
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
 * 全部抛错才向上抛（由工具层转为 isError）。
 */
export async function searchWithFallback(
  query: string,
  options: SearchOptions = {},
): Promise<SearchOutcome> {
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

  for (let i = 0; i < variants.length; i++) {
    const { label, opts } = variants[i];
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
      if (i > 0) {
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
