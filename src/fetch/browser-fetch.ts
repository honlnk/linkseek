import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { validateUrl, SsrfError } from './url-validator.js';
import { htmlToMarkdown } from './html-to-md.js';
import { FetchError, truncate } from './http-fetch.js';

/**
 * browser-fetch 微容器的响应体。
 * 成功时返回渲染后的 HTML，失败时返回 error。
 */
interface RenderResponse {
  html?: string;
  error?: string;
}

/**
 * 浏览器渲染获取适配器。
 *
 * 通过 HTTP 调用独立部署的 browser-fetch 微容器（Playwright + Chromium），
 * 让无头浏览器渲染 JS 动态页面后返回 HTML，再复用 htmlToMarkdown 转换。
 *
 * SSRF 防护：主服务侧先做 validateUrl 静态校验（拦截字面量内网 IP），
 * 微容器内部再做完整的 DNS 解析过滤（见 browser-fetch/src）。
 */
export class BrowserFetchProvider {
  constructor(
    private readonly baseUrl: string = config.BROWSER_FETCH_URL,
    private readonly timeout: number = config.BROWSER_FETCH_TIMEOUT,
  ) {}

  /**
   * 渲染指定 URL 并返回 Markdown 正文。
   *
   * 流程：URL 静态校验 → 调用微容器 /render → HTML→Markdown → 截断
   */
  async renderAsMarkdown(rawUrl: string): Promise<string> {
    // 第一道防线：静态 SSRF 校验（拦截字面量 IP、协议、userinfo）
    const safeUrl = validateUrl(rawUrl);
    const target = safeUrl.href;

    const endpoint = `${this.baseUrl}/render`;
    logger.debug({ endpoint, url: target, timeout: this.timeout }, 'browser-fetch 请求');

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: target, timeout: this.timeout }),
      signal: AbortSignal.timeout(this.timeout + 5_000), // 比渲染超时多 5s 余量
    }).catch((err: unknown) => {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new FetchError(
          `browser-fetch 请求超时（${this.timeout}ms）`,
          'timeout',
        );
      }
      throw new FetchError(
        `browser-fetch 不可达: ${err instanceof Error ? err.message : String(err)}`,
        'network',
      );
    });

    if (!response.ok) {
      throw new FetchError(
        `browser-fetch 返回 HTTP ${response.status}`,
        'http',
        response.status,
      );
    }

    const data = (await response.json()) as RenderResponse;

    if (data.error) {
      // 微容器内部的 SSRF 拦截透传为 SsrfError，其余为渲染失败
      if (/SSRF|阻断范围/i.test(data.error)) {
        throw new SsrfError(data.error);
      }
      throw new FetchError(`浏览器渲染失败: ${data.error}`, 'http');
    }

    if (!data.html) {
      throw new FetchError('browser-fetch 未返回 HTML 内容', 'http');
    }

    const markdown = htmlToMarkdown(data.html, target);
    if (!markdown) {
      throw new FetchError('渲染后页面正文为空', 'http');
    }
    return truncate(markdown);
  }
}

/** 进程内单例 */
export const browserFetchProvider = new BrowserFetchProvider();
