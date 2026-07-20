import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { config, isProduction } from './config.js';
import { logger } from './utils/logger.js';
import { createKeyStore } from './auth/key-store.js';
import { createApiKeyVerifier } from './auth/verifier.js';
import { sessionMiddleware } from './auth/session.js';
import { registerTools } from './tools/register.js';
import { recordUsage } from './utils/usage.js';
import { createAdminRouter } from './admin/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keyStore = createKeyStore();

const app = express();
app.use(express.json());
// 生产环境在 Nginx 后面，需要信任代理以获取真实协议/IP（影响 secure cookie）
if (isProduction) app.set('trust proxy', 1);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ---- 默认站点（文档 + MCP）vs 后台站点（Vue SPA）----
// linkseek 默认行为是「文档站 + MCP 服务」，后台管理是特例。
//   1. 默认站点（localhost / 公开域名 linkseek.honlnk.com / IP）
//      - GET  /        → 文档页 HTML（浏览器访问）
//      - POST /        → MCP 服务（AI 工具配裸域名 + Authorization，靠方法区分）
//      - GET  /mcp     → 405 JSON-RPC（无状态模式不支持 GET）
//      - POST /mcp     → MCP 服务（兼容显式路径）
//      - 其余路径      → 404（不暴露后台 API）
//   2. 后台站点（ADMIN_DOMAIN，如 admin.linkseek.honlnk.com）：完整 Vue SPA + REST API
//
// 这样本地与生产行为对齐：localhost:7300 ↔ linkseek.honlnk.com，localhost:7317 ↔ admin.*.honlnk.com
// Nginx 反代链路（honlnk-gateway → linkseek-gateway）已透传 Host 头，此处分流可靠。
const isAdminSite = (req: express.Request) => req.hostname === config.ADMIN_DOMAIN;
const docsHtmlPath = path.resolve(__dirname, '../public/docs.html');

app.use((req, res, next) => {
  if (isAdminSite(req)) return next(); // 后台域名 → 走后续 admin 路由（session/api/spa）
  // 默认域名：文档页（GET / 或 GET /index.html）
  if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
    return res.sendFile(docsHtmlPath);
  }
  if (req.path === '/' || req.path === '/mcp' || req.path === '/health') return next(); // 放行给 MCP / health handler
  return res.status(404).send('Not Found'); // /api、SPA 路径等一律 404（文档站不暴露后台）
});

// ---- 管理后台 REST API（仅后台域名可达，上面的中间件已把默认域名的 /api 拦截到 404）----
app.use(sessionMiddleware);
app.use('/api', createAdminRouter());

// ---- MCP 端点 ----
// 无状态模式：每个请求创建独立的 transport + server，不保留会话状态。
// 适合 Nginx 反代 + API Key 鉴权的部署形态。

function createServer() {
  const server = new McpServer(
    { name: 'linkseek', version: '0.1.0' },
    { capabilities: { logging: {} } },
  );
  registerTools(server);
  return server;
}

const mcpAuth = requireBearerAuth({
  verifier: createApiKeyVerifier(keyStore),
});

// MCP 请求处理（无状态模式：每个请求独立 transport + server）
async function handleMcpRequest(req: express.Request, res: express.Response) {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    // 用量记录：仅对 tools/call 请求记录
    const keyId = req.auth?.extra?.keyId as string | undefined;
    const body = req.body as { method?: string; params?: { name?: string } } | undefined;
    const toolName = body?.method === 'tools/call' ? body.params?.name : undefined;
    if (keyId && toolName) {
      recordUsage(keyId, toolName, true);
    }
  } catch (err) {
    logger.error({ err }, 'MCP 请求处理失败');
    // 失败也记录用量（如果知道工具名）
    const keyId = req.auth?.extra?.keyId as string | undefined;
    const body = req.body as { method?: string; params?: { name?: string } } | undefined;
    const toolName = body?.method === 'tools/call' ? body.params?.name : undefined;
    if (keyId && toolName) recordUsage(keyId, toolName, false);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  } finally {
    req.on('close', () => {
      transport.close();
      server.close();
    });
  }
}

// MCP 无状态模式拒绝 GET/DELETE（返回 JSON-RPC 错误而非 HTML）
function rejectMcpStateless(_req: express.Request, res: express.Response) {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed (stateless mode)' },
      id: null,
    }),
  );
}

// MCP 端点挂载策略：
//   POST / 和 POST /mcp  → MCP 服务（mcpAuth 鉴权）
//   GET/DELETE /mcp      → 返回 405 JSON-RPC（无状态模式不支持）
//   GET /                → 不挂 MCP：public 域名在分流中间件返回文档页，
//                          admin 域名落到下方 SPA fallback 返回 index.html
// 根路径 POST MCP 只在 public 域名真正会被触发（admin 域名下 POST / 不常见，
// 但即便误触发也只是被 mcpAuth 拦截要求 Bearer，对 SPA 无副作用）。
app.post('/', mcpAuth, handleMcpRequest);
app.post('/mcp', mcpAuth, handleMcpRequest);
app.get('/mcp', rejectMcpStateless);
app.delete('/mcp', rejectMcpStateless);

// ---- Vue SPA 静态托管 ----
const webDist = path.resolve(__dirname, '../web/dist');
app.use(express.static(webDist, { index: false, maxAge: '1y', immutable: true }));
// SPA history-mode 回退：非 /api、非 /mcp 的 GET 请求返回 index.html
app.get(/^(?!\/(api|mcp)).*/, (_req, res, next) => {
  res.sendFile(path.join(webDist, 'index.html'), (err) => {
    if (err) next();
  });
});

app.listen(config.PORT, () => {
  logger.info(`linkseek 服务已启动: http://localhost:${config.PORT}`);
  logger.info(`文档页（浏览器 GET /）+ MCP 端点（POST / + Bearer）: http://localhost:${config.PORT}/`);
  logger.info(`后台管理: http://localhost:7317/（pnpm web:dev）或 http://${config.ADMIN_DOMAIN}/（生产）`);
});
