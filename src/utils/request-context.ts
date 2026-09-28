/**
 * 请求级上下文（基于 AsyncLocalStorage）。
 *
 * 用途：MCP transport 对中间件层（handleMcpRequest）是不可见的——工具回调的
 * 返回值被 transport 直接序列化进 HTTP 响应，Express handler 拿不到工具内部
 * 计算的 token 用量。这里用 ALS 打通这条通道：
 *
 * 1. handleMcpRequest 调用 requestContext.run({ keyId }, fn) 建立上下文；
 * 2. AI 工具在 LLM 调用拿到 result.usage 后，往 store 回写 ai 字段；
 * 3. 请求结束后，handleMcpRequest 从 store 读出 ai，连同 success 一起记入 UsageLog。
 *
 * Node 的 AsyncLocalStorage 在 fetch/await/Promise 链中可靠传播，
 * MCP SDK 的工具回调处于同一异步链，因此可正常读写。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NormalizedUsage } from '../llm/types.js';

/** 工具回写的 AI 用量载荷（含成本） */
export interface AiUsagePayload {
  /** 所用 Provider ID */
  providerId: string;
  /** 调用所用模型名 */
  model: string;
  /** 归一化后的 token 用量 */
  usage: NormalizedUsage;
  /** 本次调用估算成本（单一货币） */
  cost: number;
}

/** 单次请求的上下文 */
export interface RequestContext {
  /** 发起请求的 API Key ID（来自 req.auth.extra.keyId） */
  keyId?: string;
  /** AI 工具回写的用量（非 AI 工具调用时为 undefined） */
  ai?: AiUsagePayload;
  /**
   * 本次 tools/call 是否走了 defer 脱手路径。
   * true 时中间件层跳过请求尾的 UsageLog 记录——
   * 该调用的用量由 TaskManager 在任务完成时聚合记账，避免双记。
   */
  deferred?: boolean;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * 向当前请求上下文累加一次 LLM 调用的用量与成本。
 *
 * 同步路径的 AI 工具单次调用（原有行为：直接赋值）与
 * 任务路径的多调用聚合（预处理/筛选/蒸馏/综合各计一次）统一走这里：
 * 首次写入即建立 store.ai，后续调用对 token 与成本求和；
 * providerId/model 取首次调用的值（单个任务/请求内不会混用 Provider）。
 * 无上下文（不应发生）时静默丢弃。
 */
export function accumulateAiUsage(payload: AiUsagePayload): void {
  const store = requestContext.getStore();
  if (!store) return;
  const cur = store.ai;
  if (!cur) {
    store.ai = payload;
    return;
  }
  store.ai = {
    providerId: cur.providerId,
    model: cur.model,
    usage: {
      promptTokens: cur.usage.promptTokens + payload.usage.promptTokens,
      completionTokens: cur.usage.completionTokens + payload.usage.completionTokens,
      cacheHitTokens: (cur.usage.cacheHitTokens ?? 0) + (payload.usage.cacheHitTokens ?? 0),
      cacheMissTokens: (cur.usage.cacheMissTokens ?? 0) + (payload.usage.cacheMissTokens ?? 0),
      cacheWriteTokens: (cur.usage.cacheWriteTokens ?? 0) + (payload.usage.cacheWriteTokens ?? 0),
    },
    cost: round6(cur.cost + payload.cost),
  };
}

/** 保留 6 位小数（与 utils/cost.ts 的 round6 一致，此处避免循环依赖） */
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
