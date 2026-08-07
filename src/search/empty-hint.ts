/**
 * 搜索无结果时的诊断提示。
 *
 * SearXNG 的分类是引擎集合标签，不是语义分类器：
 * - 某分类下的引擎可能因限流、超时或代理问题整体无响应
 * - 该查询可能在指定分类的引擎里本就没有结果
 * 此时建议放宽到 general 或显式指定 engines，而不是凭空生成结果。
 */
export function buildEmptyHint(categories?: string, engines?: string): string {
  const hints: string[] = [];
  if (categories && categories !== 'general') {
    hints.push(`分类「${categories}」的引擎可能暂时无响应或不匹配该查询，可尝试 categories=general`);
  }
  if (!engines) {
    hints.push('或用 engines 显式指定引擎（如 engines=google,bing）');
  }
  if (hints.length === 0) return '';
  return '建议：' + hints.join('；') + '。';
}
