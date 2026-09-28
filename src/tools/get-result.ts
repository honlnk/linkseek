import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { taskManager } from '../tasks/manager.js';
import type { TaskSnapshot } from '../tasks/manager.js';

export const getResultInput = {
  taskId: z
    .string()
    .min(1)
    .describe('异步任务 ID（defer 提交或 web_research 调用返回的 task_ 开头字符串）'),
};

export const getResultDescription = `查询异步任务（defer 脱手模式 / web_research）的进度与结果。

- 立即返回当前状态：排队中 / 执行中（带进度文案）/ 已完成 / 失败 / 已过期
- 任务完成时返回的内容与对应同步工具的返回格式完全一致
- 未完成时不会等待——先去做别的事，建议 15-30 秒后再查，禁止无间隔连续查询
- 完成结果保留 60 分钟，过期后返回「已过期」；服务重启后内存任务丢失，返回「不存在」`;

export function registerGetResult(server: McpServer): void {
  server.registerTool(
    'get_result',
    { description: getResultDescription, inputSchema: getResultInput },
    async ({ taskId }) => {
      const snap = taskManager.get(taskId);
      if (!snap || snap.status === 'not_found') {
        return {
          content: [
            {
              type: 'text',
              text: `任务 ${taskId} 不存在。可能原因：ID 有误；或服务已重启（任务仅存于内存）。请重新提交任务。`,
            },
          ],
        };
      }
      if (snap.status === 'expired') {
        return {
          content: [
            {
              type: 'text',
              text: `任务 ${taskId} 的结果已过保留期（60 分钟）。请重新提交任务并在完成后及时取结果。`,
            },
          ],
        };
      }
      if (snap.status === 'queued' || snap.status === 'running') {
        const s = snap as TaskSnapshot;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                taskId,
                kind: s.kind,
                status: s.status,
                progress: s.progress ?? '排队等待中',
                提示: '任务尚未完成。先做其他工作，建议 15-30 秒后再查；禁止无间隔连续查询。',
              }),
            },
          ],
        };
      }
      if (snap.status === 'failed') {
        const s = snap as TaskSnapshot;
        return {
          isError: true,
          content: [{ type: 'text', text: `任务执行失败: ${s.error ?? '未知错误'}` }],
        };
      }
      // done：内容与同步工具返回格式完全一致（含 isError 软失败语义）
      const s = snap as TaskSnapshot;
      return { content: s.result!.content, isError: s.result!.isError };
    },
  );
}
