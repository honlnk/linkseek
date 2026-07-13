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

// ---- 管理后台 REST API ----
app.use(sessionMiddleware);
app.use('/api', createAdminRouter());

// ---- MCP 端点 ----
// 无状态模式：每个请求创建独立的 transport + server，不保留会话状态。
// 适合 Nginx 反代 + API Key 鉴权的部署形态。

function createServer() {
  const server = new McpServer(
    { name: 'web-fetch', version: '0.1.0' },
    { capabilities: { logging: {} } },
  );
  registerTools(server);
  return server;
}

const mcpAuth = requireBearerAuth({
  verifier: createApiKeyVerifier(keyStore),
});

app.post('/mcp', mcpAuth, async (req, res) => {
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
});

app.get('/mcp', (_req, res) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed (stateless mode)' },
      id: null,
    }),
  );
});
app.delete('/mcp', (_req, res) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed (stateless mode)' },
      id: null,
    }),
  );
});

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
  logger.info(`web-fetch-mcp 服务已启动: http://localhost:${config.PORT}`);
  logger.info(`MCP 端点: http://localhost:${config.PORT}/mcp`);
  logger.info(`管理后台: http://localhost:${config.PORT}/`);
});
