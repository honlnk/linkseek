/**
 * 单个来源页面的抓取（带 WAF/SPA 自动降级浏览器渲染）。
 *
 * web_search_answer 与 web_research 流水线共用：
 * 1. HTTP 抓取正文
 * 2. 低质内容（WAF 挑战页）→ 浏览器渲染降级
 * 3. 403/429 → 浏览器渲染降级
 * 全部失败返回 ''（调用方按「仅有摘要」处理），渲染也抛错则记日志返回 ''。
 */
import { fetchPageAsMarkdown, FetchError } from './http-fetch.js';
import { isLowQualityContent } from './content-quality.js';
import { browserFetchProvider } from './browser-fetch.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export async function fetchSourceMarkdown(url: string): Promise<string> {
  try {
    let markdown = await fetchPageAsMarkdown(url);
    if (isLowQualityContent(markdown) && config.BROWSER_FETCH_ENABLED) {
      logger.warn({ url }, '抓取疑似 WAF 挑战页，降级浏览器渲染');
      markdown = await browserFetchProvider.renderAsMarkdown(url);
    }
    return markdown;
  } catch (err) {
    if (
      err instanceof FetchError &&
      (err.statusCode === 403 || err.statusCode === 429) &&
      config.BROWSER_FETCH_ENABLED
    ) {
      logger.warn({ url, reason: err.message }, '抓取 HTTP 失败，降级浏览器渲染');
      try {
        return await browserFetchProvider.renderAsMarkdown(url);
      } catch (renderErr) {
        logger.warn({ url, reason: renderErr instanceof Error ? renderErr.message : String(renderErr) }, '浏览器渲染也失败');
        return '';
      }
    }
    logger.warn({ url, reason: err instanceof Error ? err.message : String(err) }, '来源页面抓取失败');
    return '';
  }
}
