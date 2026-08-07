import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listProviders } from '../llm/provider-store.js';

export function registerListModels(server: McpServer): void {
  server.registerTool(
    'list_models',
    {
      description: `列出当前可用的 AI 模型（Provider）。

- 返回所有已启用的 AI 模型配置，含名称、协议、模型名、是否默认
- 当 web_fetch_answer 或 web_search_answer 报错时，可调用本工具查看有哪些备选模型
- 在 web_fetch_answer / web_search_answer 的 model 参数中传入 Provider 名称（name 字段）即可切换模型`,
      inputSchema: {},
    },
    async () => {
      const providers = await listProviders();
      const enabled = providers.filter((p) => p.enabled);

      if (enabled.length === 0) {
        return {
          content: [{ type: 'text', text: '当前没有可用的 AI 模型。请在后台管理中配置 LLM Provider。' }],
        };
      }

      const lines = enabled.map((p) => {
        const tags = [];
        if (p.isDefault) tags.push('默认');
        const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
        return `- ${p.name}${tagStr}\n  协议: ${p.protocol}\n  模型: ${p.model}`;
      });

      const text = `当前可用的 AI 模型（共 ${enabled.length} 个）：\n\n${lines.join('\n\n')}`;
      return { content: [{ type: 'text', text }] };
    },
  );
}
