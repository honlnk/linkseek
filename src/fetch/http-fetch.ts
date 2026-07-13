import { Agent, fetch } from 'undici';
import { URL } from 'node:url';
import { config } from '../config.js';
import { validateUrl, safeLookup, SsrfError } from './url-validator.js';
import { htmlToMarkdown } from './html-to-md.js';
import { logger } from '../utils/logger.js';

const MAX_CONTENT_BYTES = 100 * 1024; // 100KB，超过则截断

/**
 * 全局共享的 SSRF 安全 Agent。
 * safeLookup 会拦截内网/元数据 IP，并固定解析结果防 DNS rebinding。
 */
const ssrfAgent = new Agent({
  connect: { lookup: safeLookup },
});

const COMMON_HEADERS: Record<string, string> = {
  'User-Agent': 'linkseek/0.1 (+https://github.com/linkseek)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly code: 'ssrf' | 'http' | 'redirect' | 'timeout' | 'size' | 'network',
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

/**
 * 安全获取网页内容，返回 Markdown 正文。
 *
 * 流程：URL 校验 → 逐跳重定向（每跳重新校验） → 读取响应体（带大小限制） → HTML→Markdown → 截断
 */
export async function fetchPageAsMarkdown(rawUrl: string): Promise<string> {
  let currentUrl = validateUrl(rawUrl);
  let redirects = 0;

  // ---- 重定向循环（每跳都重新走 SSRF 校验）----
  let response: Response;
  while (true) {
    if (redirects > config.MAX_REDIRECTS) {
      throw new FetchError(`重定向次数超过上限 (${config.MAX_REDIRECTS})`, 'redirect');
    }

    logger.debug({ url: currentUrl.href }, 'fetch 请求');

    response = await fetch(currentUrl, {
      method: 'GET',
      headers: COMMON_HEADERS,
      dispatcher: ssrfAgent,
      redirect: 'manual', // 手动处理，确保每跳都校验
    }).catch((err: unknown) => {
      if (err instanceof SsrfError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new FetchError(`请求超时（${config.FETCH_TIMEOUT}ms）`, 'timeout');
      }
      // undici 会把 safeLookup 抛的 SsrfError 包在 connect 错误里
      if (err instanceof Error && /SSRF|阻断范围/i.test(err.message)) {
        throw new SsrfError(err.message);
      }
      throw new FetchError(
        `网络请求失败: ${err instanceof Error ? err.message : String(err)}`,
        'network',
      );
    });

    // 3xx 重定向
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new FetchError(`${response.status} 重定向但缺少 Location 头`, 'redirect');
      }
      redirects++;
      // 重新校验目标 URL（含 SSRF 校验）
      currentUrl = validateUrl(new URL(location, currentUrl.href).href);
      continue;
    }

    break; // 非重定向，进入内容读取
  }

  if (!response.ok) {
    throw new FetchError(`目标返回 HTTP ${response.status}`, 'http', response.status);
  }

  const contentType = response.headers.get('content-type') || '';
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > config.MAX_RESPONSE_SIZE) {
    throw new FetchError(
      `响应体过大: ${formatBytes(contentLength)} > ${formatBytes(config.MAX_RESPONSE_SIZE)}`,
      'size',
    );
  }

  // ---- 读取响应体（带大小保护）----
  const html = await readBodyWithLimit(response, config.MAX_RESPONSE_SIZE);

  // 非 HTML 直接当文本返回
  if (!contentType.includes('html') && !contentType.includes('xml')) {
    return truncate(html);
  }

  const markdown = htmlToMarkdown(html, currentUrl.href);
  if (!markdown) {
    throw new FetchError('页面正文为空（可能是 JS 渲染的 SPA，当前不支持浏览器渲染）', 'http');
  }
  return truncate(markdown);
}

/** 带大小上限的流式读取，超限直接抛错 */
async function readBodyWithLimit(response: Response, limitBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const chunks: string[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      throw new FetchError(
        `响应体超过大小上限 ${formatBytes(limitBytes)}（已读 ${formatBytes(total)}）`,
        'size',
      );
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode()); // flush
  return chunks.join('');
}

/** 内容截断到 MAX_CONTENT_BYTES */
function truncate(text: string): string {
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes <= MAX_CONTENT_BYTES) return text;
  const truncated = Buffer.from(text, 'utf-8').subarray(0, MAX_CONTENT_BYTES).toString('utf-8');
  return `${truncated}\n\n---\n[内容已截断，原文约 ${formatBytes(bytes)}]`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
