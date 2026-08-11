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
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
