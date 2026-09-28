/**
 * LLM 调用成本计算（从 duet 移植，适配单一货币场景）。
 *
 * 单价为「每 100 万 token」的价格（PerMTok），由各 Provider 的 pricing 配置提供。
 * 单一货币：所有 Provider 价格假定同一币种（由全局 config.CURRENCY 决定），
 * 成本为纯数字累加，不做汇率转换。
 */
import type { NormalizedUsage } from '../llm/types.js';

/**
 * Provider 价格配置（单一货币，不含 currency 字段——币种由全局 config 决定）。
 * - 输入（未命中）、输出为基础计费项；
 * - 缓存命中/写入为可选维度，由对应开关控制是否计入成本。
 */
export interface ProviderPricing {
  /** 输入（缓存未命中）单价 */
  inputPerMTok: number;
  /** 输出单价 */
  outputPerMTok: number;
  /** 是否启用缓存命中计价维度（默认 true） */
  cacheHitEnabled: boolean;
  /** 缓存命中单价（通常远低于输入） */
  cacheHitPerMTok: number;
  /** 是否启用缓存写入计价维度（默认 false） */
  cacheWriteEnabled: boolean;
  /** 缓存写入单价（仅少数模型存在该计费维度） */
  cacheWritePerMTok: number;
}

/** 未指定 Provider 单价时的兜底参考价（CNY/百万 token，DeepSeek 量级） */
export const FALLBACK_INPUT_PER_MTOK = 0.27;
export const FALLBACK_OUTPUT_PER_MTOK = 1.1;

/**
 * 计算单次调用增量成本。
 *
 * 计费规则：
 * - 输入：有缓存拆分时按「未命中 token × input 单价」计；无拆分时按 promptTokens 全量计。
 * - 缓存命中：cacheHitEnabled 为真时计（通常远低于输入价）。
 * - 缓存写入：cacheWriteEnabled 为真时计（仅少数模型）。
 * - 输出：completionTokens × output 单价。
 *
 * @returns 该次调用成本（不四舍五入，由累加方控制精度）
 */
export function estimateStepCost(usage: NormalizedUsage, rates: ProviderPricing): number {
  const hit = usage.cacheHitTokens ?? 0;
  const miss = usage.cacheMissTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const out = usage.completionTokens ?? 0;
  // 有缓存拆分时，输入按未命中计；无拆分（如非缓存系）时按 promptTokens 全量计
  const inMiss = miss > 0 || hit > 0 ? miss : (usage.promptTokens ?? 0);

  let cost = 0;
  cost += (inMiss / 1_000_000) * rates.inputPerMTok;
  if (rates.cacheHitEnabled) {
    cost += (hit / 1_000_000) * rates.cacheHitPerMTok;
  }
  if (rates.cacheWriteEnabled) {
    cost += (write / 1_000_000) * rates.cacheWritePerMTok;
  }
  cost += (out / 1_000_000) * rates.outputPerMTok;
  return cost;
}

/** 保留 6 位小数（避免浮点漂移，用于累加） */
export function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
