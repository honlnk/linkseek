import ipaddr from 'ipaddr.js';
import dns from 'node:dns';
import { URL } from 'node:url';
import { config } from '../config.js';

/**
 * SSRF 防护模块
 *
 * 三道防线：
 * 1. URL 静态校验（协议、userinfo、长度、hostname）
 * 2. IP 范围检查（ipaddr.js 的 range() 覆盖所有内网/元数据端点）
 * 3. DNS rebinding 防护（自定义 lookup：解析→过滤→固定安全 IP）
 *
 * 关于阻断范围分层：
 * - CORE：真正不可放行的内网/元数据端点，任何环境都阻断（生产安全底线）
 * - STRICT：reserved/multicast 等，生产服务器上也应阻断，
 *   但在某些代理网络下可能误伤（如 fake-ip DNS 把域名映射到 198.18/15）。
 *   通过环境变量 SSRF_STRICT=true 开启，默认关闭。
 */

/** 核心阻断范围（始终生效） */
const CORE_BLOCKED = new Set([
  'private', // RFC1918: 10/8, 172.16/12, 192.168/16
  'loopback', // 127/8, ::1
  'linkLocal', // 169.254/16（含云元数据 169.254.169.254）, fe80::/10
  'uniqueLocal', // IPv6 fc00::/7
  'broadcast',
  'unspecified', // 0.0.0.0
  'carrierGradeNat', // 100.64/10
]);

/** 严格模式下额外阻断的范围 */
const STRICT_BLOCKED = new Set([
  'reserved', // 含 198.18/15、240/4 等
  'multicast', // 224/4, ff00/8
]);

const SSRF_STRICT = config.SSRF_STRICT;

const BLOCKED_RANGES = SSRF_STRICT
  ? new Set([...CORE_BLOCKED, ...STRICT_BLOCKED])
  : CORE_BLOCKED;

const MAX_URL_LENGTH = 2000;

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** 第一道防线：URL 静态校验 */
export function validateUrl(rawUrl: string): URL {
  if (rawUrl.length > MAX_URL_LENGTH) {
    throw new SsrfError(`URL 超过最大长度 ${MAX_URL_LENGTH}`);
  }

  let parsed: URL;
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

  // 字面量 IP（如 http://169.254.169.254）不走 DNS lookup，需在此直接校验
  const hostname = parsed.hostname.replace(/^\[|]$/g, ''); // 去除 IPv6 方括号
  if (ipaddr.isValid(hostname) && isBlockedIp(hostname)) {
    throw new SsrfError(`目标地址 ${hostname} 在阻断范围内`);
  }

  return parsed;
}

/** 第二道防线：判断单个 IP 字符串是否落在危险范围 */
export function isBlockedIp(ip: string): boolean {
  let addr;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    // 无法解析的 IP 一律阻断
    return true;
  }

  // IPv4-mapped IPv6 归一化，让 ::ffff:169.254.169.254 也能被识别
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      addr = v6.toIPv4Address();
    }
  }

  const range = addr.range();
  return BLOCKED_RANGES.has(range);
}

/**
 * 第三道防线：安全的 DNS lookup。
 * 透传调用方的原始 options 给 dns.lookup（undici 会传 hints/all 等），
 * 在回调里过滤危险 IP，并按 options.all 的值适配返回格式。
 *
 * DNS rebinding 防护：undici/net 模块会直接使用这里返回的 address 建立连接，
 * 不再二次解析，因此过滤后返回的安全 IP 就是最终连接目标。
 *
 * 用法：作为 undici Agent 的 connect.lookup。
 */
export function safeLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family: number,
  ) => void,
): void {
  // 字面量 IP 直接校验（如 http://169.254.169.254 不走 DNS）
  if (ipaddr.isValid(hostname) && isBlockedIp(hostname)) {
    const err: NodeJS.ErrnoException = new SsrfError(`目标地址 ${hostname} 在阻断范围内`);
    err.code = 'ESSRF';
    callback(err, '', 0);
    return;
  }

  dns.lookup(hostname, options, (err, result) => {
    if (err) {
      callback(err, '', 0);
      return;
    }
    // options.all=true 时 result 是数组，否则是单个地址串
    const list: dns.LookupAddress[] = Array.isArray(result)
      ? result
      : [{ address: result as string, family: (result as unknown as { family?: number }).family ?? 4 }];

    const safe = list.filter((a) => !isBlockedIp(a.address));
    if (safe.length === 0) {
      const err2: NodeJS.ErrnoException = new SsrfError(
        `SSRF 拦截: ${hostname} 解析到的 IP 全部在阻断范围内 (${list.map((a) => a.address).join(', ')})`,
      );
      err2.code = 'ESSRF';
      callback(err2, '', 0);
      return;
    }
    // 按调用方期望的格式返回（options.all 为 true 时返回数组）
    if (options.all) {
      callback(null, safe, safe[0].family);
    } else {
      callback(null, safe[0].address, safe[0].family);
    }
  });
}
