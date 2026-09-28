/**
 * 前端共享常量。
 * 从 Dashboard.vue / KeyDetail.vue 中提取，避免重复定义。
 */

/** 各工具对应的展示色（与后端工具名一致）。未知工具回退到灰色。 */
export const toolColors: Record<string, string> = {
  web_search: '#2080f0',
  web_fetch: '#18a058',
  web_search_and_fetch: '#f0a020',
  web_fetch_render: '#d03050',
  list_models: '#8a2be2',
  web_fetch_answer: '#36ad6a',
  web_search_answer: '#ff9d3d',
};

/** 未知工具的兜底色 */
export const FALLBACK_COLOR = '#999';

/** 取工具色，未知则返回兜底色 */
export function toolColor(tool: string): string {
  return toolColors[tool] ?? FALLBACK_COLOR;
}
