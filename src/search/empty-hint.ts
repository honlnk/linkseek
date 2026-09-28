import type { SearchDiagnostics } from './provider.js';

/**
 * 空结果报告。服务端已通过降级重试链尽力（见 search/fallback.ts），
 * 这里的职责是把「做过什么、为什么空、下一步怎么办」如实告诉调用方，
 * 让 AI 能做出有依据的决策（改写重试 / 换工具 / 告知用户引擎故障），
 * 而不是对着一句"未找到"瞎猜。
 */
export function buildEmptyReport(query: string, diagnostics?: SearchDiagnostics): string {
  const lines: string[] = [`未找到与「${query}」相关的结果。`];

  if (diagnostics && diagnostics.attempts.length > 0) {
    const tried = diagnostics.attempts
      .map((a) => `${a.label}(${a.resultCount < 0 ? `请求失败: ${a.error ?? '未知错误'}` : `${a.resultCount} 条`})`)
      .join(' → ');
    lines.push(`已自动尝试 ${diagnostics.attempts.length} 组参数：${tried}。`);
    if (diagnostics.unresponsiveEngines.length > 0) {
      lines.push(
        `无响应引擎：${diagnostics.unresponsiveEngines.join('、')}（可能被上游限流或网络故障）。`,
      );
    }
  }

  lines.push(
    '建议：把查询改写为更简洁的关键词（去掉引号 / OR / AND / site: 等搜索运算符）后重试一次；' +
      '若仍无结果，可能是引擎侧故障，建议改用其他搜索途径并稍后再试。',
  );

  return lines.join('\n');
}
