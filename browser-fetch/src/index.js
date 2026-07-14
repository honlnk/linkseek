/**
 * browser-fetch 微容器入口
 *
 * Express HTTP 服务，提供：
 *   GET  /health —— 健康检查
 *   POST /render —— 接收 { url, timeout }，用无头浏览器渲染页面返回 HTML
 *
 * SSRF 防护：每个 /render 请求都走 validateUrl + resolveSafeIp，
 * 确认安全后让浏览器用安全 IP 直连（设 Host 头为原域名），杜绝 DNS rebinding。
 */
import express from 'express';
import { chromium } from 'playwright';
import { validateUrl, resolveSafeIp, SsrfError } from './ssrf.js';

const PORT = Number(process.env.PORT ?? 9100);

const app = express();
app.use(express.json());

/** 浏览器单例（常驻，避免每次请求冷启动） */
let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/render', async (req, res) => {
  const { url, timeout = 30_000 } = req.body ?? {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '缺少 url 参数' });
  }

  let safeUrl;
  let safeIp;
  try {
    safeUrl = validateUrl(url);
    safeIp = await resolveSafeIp(safeUrl.hostname);
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }

  const port = safeUrl.port || (safeUrl.protocol === 'https:' ? '443' : '80');
  // 用安全 IP 直连，带原 hostname 作为 Host 头（绕过 DNS rebinding）
  const directUrl = `${safeUrl.protocol}//${safeIp}:${port}${safeUrl.pathname}${safeUrl.search}`;

  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage({
      extraHTTPHeaders: { Host: safeUrl.hostname },
    });
    await page.goto(directUrl, {
      waitUntil: 'networkidle',
      timeout: Math.min(Number(timeout) || 30_000, 60_000),
    });
    const html = await page.content();
    return res.json({ html });
  } catch (err) {
    return res.status(502).json({
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

const server = app.listen(PORT, () => {
  console.log(`browser-fetch listening on :${PORT}`);
});

// 优雅关闭：关闭浏览器进程
async function shutdown() {
  console.log('browser-fetch shutting down...');
  server.close();
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
