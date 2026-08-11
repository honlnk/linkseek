import { prisma } from '../lib/prisma.js';
import { logger } from './logger.js';
import type { AiUsagePayload } from './request-context.js';

/**
 * 异步记录一次 MCP 工具调用。
 *
 * 写入失败不抛错（不阻塞主流程），只记日志。
 * 仅对 tools/call 请求有意义；其他请求（initialize / tools/list）调用方不会触发此函数。
 *
 * @param ai AI 工具（web_fetch_answer / web_search_answer）回写的用量载荷；
 *           非 AI 工具不传，相关字段保持默认 0 / null。
 */
export function recordUsage(
  keyId: string,
  toolName: string,
  success: boolean,
  ai?: AiUsagePayload,
): void {
  prisma.usageLog
    .create({
      data: ai
        ? {
            keyId,
            toolName,
            success,
            providerId: ai.providerId,
            model: ai.model,
            promptTokens: ai.usage.promptTokens,
            completionTokens: ai.usage.completionTokens,
            cacheHitTokens: ai.usage.cacheHitTokens,
            cacheMissTokens: ai.usage.cacheMissTokens,
            cacheWriteTokens: ai.usage.cacheWriteTokens,
            cost: ai.cost,
          }
        : { keyId, toolName, success },
    })
    .catch((err) => {
      logger.warn({ err, keyId, toolName }, '用量记录写入失败');
    });
}
