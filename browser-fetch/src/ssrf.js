/**
 * SSRF 防护模块（browser-fetch 微容器自用）
 *
 * 浏览器自己做 DNS 解析，会绕过主服务 undici Agent 的 safeLookup 防护。
 * 因此微容器收到 URL 后，自行做三道防线：
 *   1. URL 静态校验（协议、userinfo、长度、hostname）
 *   2. IP 范围检查
 *   3. DNS 解析过滤 —— 解析域名，丢弃危险 IP，返回安全 IP + 端口
 *
 * 浏览器随后用返回的安全 IP 直连（带原 Host 头），杜绝 DNS rebinding。
 */
import ipaddr from 'ipaddr.js';
import dns from 'node:dns';
import { URL } from 'node:url';

/** 始终阻断的范围（内网 + 云元数据端点） */
const CORE_BLOCKED = new Set([
  'private',
  'loopback',
  'linkLocal', // 含云元数据 169.254.169.254
  'uniqueLocal',
  'broadcast',
  'unspecified',
  'carrierGradeNat',
]);

const MAX_URL_LENGTH = 2000;

export class SsrfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** 判断 IP 是否落在危险范围 */
export function isBlockedIp(ip) {
  let addr;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true; // 无法解析一律阻断
  }
  // IPv4-mapped IPv6 归一化
  if (addr.kind() === 'ipv6') {
    if (addr.isIPv4MappedAddress()) {
      addr = addr.toIPv4Address();
    }
  }
  return CORE_BLOCKED.has(addr.range());
}

/** URL 静态校验：协议、userinfo、长度、字面量 IP */
export function validateUrl(rawUrl) {
  if (rawUrl.length > MAX_URL_LENGTH) {
    throw new SsrfError(`URL 超过最大长度 ${MAX_URL_LENGTH}`);
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError('URL 格式无效');
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new SsrfError(`不支持的协议: ${protocol}（仅允许 http/https）`);
  }
  if (parsed.username || parsed.password) {
    throw new SsrfError('禁止在 URL 中携带凭据（userinfo）');
  }
  if (!parsed.hostname) {
    throw new SsrfError('URL 缺少 hostname');
  }
  const hostname = parsed.hostname.replace(/^\[|]$/g, '');
  if (ipaddr.isValid(hostname) && isBlockedIp(hostname)) {
    throw new SsrfError(`目标地址 ${hostname} 在阻断范围内`);
  }
  return parsed;
}

/**
 * 解析 hostname，过滤危险 IP，返回第一个安全地址。
 * 字面量 IP 直接校验。域名解析后过滤，全危险则抛 SsrfError。
 */
export async function resolveSafeIp(hostname) {
  const clean = hostname.replace(/^\[|]$/g, '');
  // 字面量 IP
  if (ipaddr.isValid(clean)) {
    if (isBlockedIp(clean)) {
      throw new SsrfError(`目标地址 ${clean} 在阻断范围内`);
    }
    return clean;
  }
  const addresses = await dns.promises.lookup(clean, { all: true, family: 4 });
  const safe = addresses.filter((a) => !isBlockedIp(a.address));
  if (safe.length === 0) {
    throw new SsrfError(
      `SSRF 拦截: ${hostname} 解析到的 IP 全部在阻断范围内 (${addresses.map((a) => a.address).join(', ')})`,
    );
  }
  return safe[0].address;
}
