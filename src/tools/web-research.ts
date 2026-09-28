import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { submitDeferTask } from '../tasks/defer.js';

export const webResearchInput = {
  question: z.string().min(1).describe('想研究的问题（自然语言或关键词均可）'),
  depth: z
    .enum(['fast', 'standard', 'deep'])
    .optional()
    .describe(
      '研究深度：fast（1 轮搜索、3 来源、不蒸馏，最快出结果）/ standard（3 轮、5 来源、带蒸馏，默认）/' +
        '/ deep（5 轮、8 来源、带蒸馏，最全面也最慢）。简单事实查证用 fast，常规调研 standard，全面综述 deep',
    ),
  model: z
    .string()
    .optional()
    .describe(
      '指定 AI 模型：传入 list_models 返回的「名称」（name 字段）。不传则用默认模型。' +
        '若返回错误说模型不存在，请先调 list_models 查看可用模型，再传入正确的名称重试。',
    ),
};

export const webResearchDescription = `深度研究一个中等复杂度的问题：服务器端跑完整研究流水线，你只需提交后取结果。

- 流水线（Perplexica 式）：问题改写 → 多轮迭代搜索（空结果自动降级重试）→ LLM 筛选来源 →
  抓取正文（自动过 WAF）→ 长文分块蒸馏要点 → 充分性判断（不足自动补搜）→ 综合回答（附来源列表）
- 纯异步工具：立即返回 taskId，全程约 1-3 分钟（fast 约 20-40 秒）；用 get_result 查进度取结果
- 定位「不那么简单、也不那么复杂」的任务：简单事实查证直接用 web_search / web_search_answer（更快）；
  需要你自主决策搜索方向、边搜边想的开放任务，仍建议自己多轮 web_search
- depth 建议：快查验证 fast / 常规调研 standard / 全面综述 deep`;

export function registerWebResearch(server: McpServer): void {
  server.registerTool(
    'web_research',
    { description: webResearchDescription, inputSchema: webResearchInput },
    async (input) => submitDeferTask('web_research', input),
  );
}
