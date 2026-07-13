import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { KeyStore } from './key-store.js';

/**
 * 将 API Key 校验适配为 MCP SDK 的 OAuthTokenVerifier。
 *
 * requireBearerAuth 中间件会要求 expiresAt 是数字且未过期，
 * 对于长期有效的 API Key，这里合成一个 1 小时的滚动窗口满足约束。
 */
export function createApiKeyVerifier(keyStore: KeyStore): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const record = await keyStore.findByToken(token);
      if (!record) {
        // 注意：此消息会被 requireBearerAuth 放入 WWW-Authenticate 响应头，
        // HTTP 头不允许非 ASCII 字符，故必须使用英文。
        throw new InvalidTokenError('Unknown or disabled API key');
      }
      return {
        token,
        clientId: record.name,
        scopes: ['mcp'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        extra: { keyId: record.id, keyName: record.name },
      };
    },
  };
}
