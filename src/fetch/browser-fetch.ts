import { chromium } from 'playwright-core';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { validateUrl, SsrfError } from './url-validator.js';
import { htmlToMarkdown } from './html-to-md.js';
import { FetchError, truncate } from './http-fetch.js';

/**
 * 浏览器渲染获取适配器。
 *
 * 通过 Playwright CDP 远程连接独立的 Browserless 容器（托管 Chromium 实例池），
 * 渲染 JS 动态页面后取回 HTML，再复用 htmlToMarkdown 转换。
 *
 * 与旧架构（自写 browser-fetch 微容器 + POST /render）的区别：
 * - 浏览器实例池化由 Browserless 托管（解决每请求冷启动 + 并发 OOM）
 * - 渲染逻辑（goto / 等待 / 超时）在主服务侧控制，错误信息完整透传
 * - SSRF 防护简化为主服务侧 validateUrl 静态校验（Browserless 在内部网络）
 *
 * SSRF 防护：主服务侧 validateUrl 拦截字面量内网 IP / 非法协议 / userinfo。
 * 不再做 DNS-rebinding 锁定（--host-resolver-rules 是进程级参数，与浏览器池化冲突）。
 */
export class BrowserFetchProvider {
  constructor(
    private readonly endpoint: string = config.BROWSER_FETCH_URL,
    private readonly timeout: number = config.BROWSER_FETCH_TIMEOUT,
  ) {}

  /**
   * 渲染指定 URL 并返回 Markdown 正文。
   *
   * 流程：URL 静态校验 → CDP 连接 Browserless → domcontentloaded + 等主体 → HTML→Markdown → 截断
   */
  async renderAsMarkdown(rawUrl: string): Promise<string> {
    // 第一道防线：静态 SSRF 校验（拦截字面量内网 IP、协议、userinfo）
    const safeUrl = validateUrl(rawUrl);
    const target = safeUrl.href;

    logger.debug({ endpoint: this.endpoint, url: target, timeout: this.timeout }, 'browser-fetch 渲染请求');

    // 连接 Browserless（browser 实例由池托管，不关闭；只关 context）
    const browser = await chromium.connectOverCDP(this.endpoint).catch((err: unknown) => {
      throw new FetchError(
        `Browserless 不可达: ${err instanceof Error ? err.message : String(err)}`,
        'network',
      );
    });

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      // domcontentloaded：DOM 解析完成即返回，不苦等 networkidle（那是 502 首因）
      await page.goto(target, {
        waitUntil: 'domcontentloaded',
        timeout: this.timeout,
      });
      // 兜底等待主体元素出现，给 SPA 一点异步渲染时间（最多 5s，不阻塞太久）
      await page
        .waitForSelector('body', { timeout: Math.min(this.timeout, 5_000) })
        .catch(() => {}); // 超时不报错，继续取已有内容

      const html = await page.content();
      if (!html) {
        throw new FetchError('渲染后页面 HTML 为空', 'http');
      }

      const markdown = htmlToMarkdown(html, target);
      if (!markdown) {
        throw new FetchError('渲染后页面正文为空', 'http');
      }
      return truncate(markdown);
    } catch (err) {
      // 完整透传真实错误信息（解决旧架构"丢弃 error 文本"的黑盒问题）
      if (err instanceof FetchError || err instanceof SsrfError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      // Playwright 超时特征
      if (/Timeout .* exceeded/i.test(message)) {
        throw new FetchError(`浏览器渲染超时: ${message}`, 'timeout');
      }
      throw new FetchError(`浏览器渲染失败: ${message}`, 'http');
    } finally {
      await context.close().catch(() => {});
      // 注意：不调 browser.close()，实例归还 Browserless 池
    }
  }
}

/** 进程内单例 */
export const browserFetchProvider = new BrowserFetchProvider();
