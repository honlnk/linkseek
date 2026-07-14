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
    // 字面量 IP 不需要 DNS 锁定；域名才需要解析 + 锁定防 rebinding
    safeIp = await resolveSafeIp(safeUrl.hostname);
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }

  const renderTimeout = Math.min(Number(timeout) || 30_000, 60_000);
  // 字面量 IP 直接用原 URL；域名用 --host-resolver-rules 锁定到已校验的安全 IP
  // （浏览器用真实域名访问，HTTPS 证书正常校验；DNS 解析被锁定防 rebinding）
  const isLiteralIp = safeUrl.hostname === safeIp;
  const launchArgs = isLiteralIp
    ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    : [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        `--host-resolver-rules=MAP ${safeUrl.hostname} ${safeIp}`,
      ];

  let browser;
  let page;
  try {
    browser = await chromium.launch({ headless: true, args: launchArgs });
    page = await browser.newPage();
    await page.goto(safeUrl.href, {
      waitUntil: 'networkidle',
      timeout: renderTimeout,
    });
    const html = await page.content();
    return res.json({ html });
  } catch (err) {
    return res.status(502).json({
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
});

const server = app.listen(PORT, () => {
  console.log(`browser-fetch listening on :${PORT}`);
});

// 优雅关闭
function shutdown() {
  console.log('browser-fetch shutting down...');
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
