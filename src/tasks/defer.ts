/**
 * defer 脱手模式的工具侧公共件。
 *
 * 四个慢工具的入参加 deferParam；回调开头判断 defer 走 submitDeferTask：
 * 立即入队返回任务 ID，不等执行。keyId 从请求上下文（ALS）取，
 * 并给上下文打 deferred 标记——中间件层据此跳过请求尾的 UsageLog 记录
 * （该调用的用量由 TaskManager 在任务完成时聚合记账，避免双记）。
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { taskManager } from './manager.js';
import type { TaskKind, TaskRunContext } from './manager.js';
import { requestContext } from '../utils/request-context.js';

/** defer 参数（四个慢工具共用） */
export const deferParam = z
  .boolean()
  .optional()
  .describe(
    '设为 true 时脱手执行：立即返回任务 ID，不阻塞等待。' +
      '适合耗时长或想先做其他事的场景；之后用 get_result 工具查进度取结果（建议 15-30 秒后查询）。' +
      '不传或 false = 同步等待结果（默认，行为与原来一致）。',
  );

/** 同步路径的运行上下文（无进度消费方，静默丢弃） */
export const syncRunCtx: TaskRunContext = { setProgress: () => {} };

/**
 * 提交异步任务并构造「已受理」返回。
 * keyId 缺失（非 MCP 鉴权路径调用，理论不发生）时任务照常执行，只是不记 Key 用量。
 */
export async function submitDeferTask(
  kind: TaskKind,
  params: Record<string, unknown>,
): Promise<CallToolResult> {
  const store = requestContext.getStore();
  const taskId = await taskManager.submit(kind, params, store?.keyId);
  if (store) store.deferred = true;
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          deferred: true,
          taskId,
          status: 'queued',
          提示:
            '任务已提交后台执行。用 get_result 工具（传 taskId）查询进度与结果；' +
            '等待期间可先做其他工作，建议 15-30 秒后再查，不要无间隔连续查询。',
        }),
      },
    ],
  };
}
