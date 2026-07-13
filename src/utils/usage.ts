import { prisma } from '../lib/prisma.js';
import { logger } from './logger.js';

/**
 * 异步记录一次 MCP 工具调用。
 *
 * 写入失败不抛错（不阻塞主流程），只记日志。
 * 仅对 tools/call 请求有意义；其他请求（initialize / tools/list）调用方不会触发此函数。
 */
export function recordUsage(
  keyId: string,
  toolName: string,
  success: boolean,
): void {
  prisma.usageLog
    .create({
      data: { keyId, toolName, success },
    })
    .catch((err) => {
      logger.warn({ err, keyId, toolName }, '用量记录写入失败');
    });
}
