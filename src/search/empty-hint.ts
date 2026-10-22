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
    // commercial 尝试不是「参数组」（无 SearXNG 参数语义），从计数中排除并单独措辞，
    // 避免「已尝试 4 组参数」把商业兜底也算进去造成误导。
    const paramAttempts = diagnostics.attempts.filter((a) => a.kind !== 'commercial');
    const commercialAttempts = diagnostics.attempts.filter((a) => a.kind === 'commercial');
    if (paramAttempts.length > 0) {
      const tried = paramAttempts
        .map((a) => `${a.label}(${a.resultCount < 0 ? `请求失败: ${a.error ?? '未知错误'}` : `${a.resultCount} 条`})`)
        .join(' → ');
      lines.push(`已自动尝试 ${paramAttempts.length} 组参数：${tried}。`);
    }
    if (commercialAttempts.length > 0) {
      // 商业兜底的 error 可能是引擎失败，也可能是「凭证缺失/失效，跳过」（此时并未发起请求），
      // 无论 resultCount 是否 <0，只要带 error 就显示原因，避免把「跳过」误读成「搜了但 0 条」
      const tried = commercialAttempts
        .map((a) => `${a.label}(${a.error ? `未生效: ${a.error}` : `${a.resultCount} 条`})`)
        .join('、');
      lines.push(`商业兜底已尝试：${tried}。`);
    }
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
