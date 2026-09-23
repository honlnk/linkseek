import { chromium } from 'playwright-core';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { validateUrl, SsrfError } from './url-validator.js';
import { htmlToMarkdown } from './html-to-md.js';
import { FetchError, truncateWithInfo } from './http-fetch.js';

/**
 * 真实 Chrome UA（与 http-fetch.ts 的 COMMON_HEADERS 保持一致，降低 WAF 识别概率）。
 */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 构建 Browserless WS 端点 URL，附加 stealth + launch 参数。
 *
 * - `?stealth=true`：启用 puppeteer-extra-stealth 插件（补丁 navigator.webdriver 等）
 * - `?launch=<base64>`：传 Chromium 启动参数
 *   - `--disable-dev-shm-usage`：避免容器 /dev/shm 默认 64MB 导致崩溃
 *   - `--disable-blink-features=AutomationControlled`：隐藏自动化特征
 *   - `--proxy-server=<url>`（可选）：Chromium 页面请求走代理
 */
function buildWsEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('stealth', 'true');

  const args = [
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
  ];
  if (config.BROWSER_FETCH_PROXY) {
    args.push(`--proxy-server=${config.BROWSER_FETCH_PROXY}`);
  }

  // Browserless 的 launch 参数是 base64 编码的 JSON
  const launchConfig = JSON.stringify({ args });
  url.searchParams.set('launch', Buffer.from(launchConfig).toString('base64'));

  return url.toString();
}

/**
 * 浏览器渲染获取适配器。
 *
 * 通过 Playwright connect() 远程连接独立的 Browserless v2 容器（托管 Chromium 实例池），
 * 渲染 JS 动态页面后取回 HTML，再复用 htmlToMarkdown 转换。
 *
 * 接入方式：chromium.connect({ wsEndpoint }) 连接 browserless 的
 * /chromium/playwright 端点（browserless v2 开源版的 Playwright WS 路由）。
 *
 * 与旧架构（自写 browser-fetch 微容器 + POST /render）的区别：
 * - 浏览器实例池化由 Browserless 托管（解决每请求冷启动 + 并发 OOM）
 * - 渲染逻辑（goto / 等待 / 超时）在主服务侧控制，错误信息完整透传
 * - SSRF 防护简化为主服务侧 validateUrl 静态校验（Browserless 在内部网络）
 */
export class BrowserFetchProvider {
  private readonly wsEndpoint: string;

  constructor(baseUrl: string = config.BROWSER_FETCH_URL, private readonly timeout: number = config.BROWSER_FETCH_TIMEOUT) {
    this.wsEndpoint = buildWsEndpoint(baseUrl);
  }

  /** 渲染结果的结构化视图（REST 公开 API 的 truncated 标志用） */
  async renderAsMarkdown(rawUrl: string): Promise<string> {
    return (await this.renderAsMarkdownDetailed(rawUrl)).markdown;
  }

  /**
   * 渲染指定 URL 并返回 Markdown 正文。
   *
   * 流程：URL 静态校验 → WS 连接 Browserless（stealth + launch args）→
   *       newContext（UA + viewport + locale）→ domcontentloaded + 等主体 →
   *       HTML→Markdown → 截断
   */
  async renderAsMarkdownDetailed(rawUrl: string): Promise<{ markdown: string; truncated: boolean }> {
    // 第一道防线：静态 SSRF 校验（拦截字面量内网 IP、协议、userinfo）
    const safeUrl = validateUrl(rawUrl);
    const target = safeUrl.href;

    logger.debug({ endpoint: this.wsEndpoint, url: target, timeout: this.timeout }, 'browser-fetch 渲染请求');

    // 连接 Browserless v2 的 Playwright WS 端点（已附加 stealth + launch 参数）
    // browserless 开源版的 WS 路由是 /chromium/playwright（非根路径，非 CDP 根端点）
    const browser = await chromium.connect({ wsEndpoint: this.wsEndpoint }).catch((err: unknown) => {
      throw new FetchError(
        `Browserless 不可达: ${err instanceof Error ? err.message : String(err)}`,
        'network',
      );
    });

    // newContext 设真实浏览器指纹（stealth 插件处理 navigator 层补丁，这里补 context 层）
    const context = await browser.newContext({
      userAgent: BROWSER_UA,
      viewport: { width: 1920, height: 1080 },
      locale: 'zh-CN',
      extraHTTPHeaders: {
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
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
      const t = truncateWithInfo(markdown);
      return { markdown: t.text, truncated: t.truncated };
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
