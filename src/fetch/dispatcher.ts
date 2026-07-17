import { Agent, EnvHttpProxyAgent } from 'undici';
import { config } from '../config.js';
import { safeLookup } from './url-validator.js';

/**
 * 出站 HTTP 请求的 dispatcher 集中管理。
 *
 * 两类 dispatcher：
 *   1. 抓取目标网站（走代理）：由 createFetchDispatcher() 按配置返回
 *      - 未配代理：返回 ssrfAgent（带 safeLookup 的 DNS 过滤）
 *      - 配了代理：返回 EnvHttpProxyAgent（走 CONNECT 隧道）
 *   2. 调用内网服务（SearXNG 等）：始终用 ssrfAgent，不走代理
 *
 * SSRF 防护说明：
 *   走代理时，CONNECT 隧道由代理接管 DNS 解析，safeLookup 的 DNS 过滤失效。
 *   但 validateUrl 的字面量内网 IP 校验仍每跳生效（不依赖 DNS），
 *   且代理为用户自有可信服务（如 Clash），DNS rebinding 攻击面已大幅收窄。
 */

/**
 * SSRF 安全 Agent（带 safeLookup DNS 过滤）。
 * 用于抓取外部目标网站（未配代理时的直连）。
 * 注意：会拦截内网 IP，不可用于调用内网服务（如 SearXNG）。
 */
export const ssrfAgent = new Agent({
  connect: { lookup: safeLookup },
});

/**
 * 普通 Agent（无 SSRF 校验），用于调用可信内网服务（如 SearXNG）。
 * 这些服务本身就在内网，safeLookup 会误拦其 private IP。
 */
export const internalAgent = new Agent();

/**
 * 抓取目标网站用的 dispatcher。
 * 配了代理走 EnvHttpProxyAgent，否则退回 ssrfAgent 直连。
 *
 * 注：EnvHttpProxyAgent.Options 继承 ProxyAgent.Options，支持传 connect，
 * 但 CONNECT 隧道场景下 lookup 不生效（代理接管 DNS），故不重复传。
 */
export const fetchDispatcher: Agent | EnvHttpProxyAgent = config.HTTPS_PROXY || config.HTTP_PROXY
  ? new EnvHttpProxyAgent({
      httpProxy: config.HTTP_PROXY,
      httpsProxy: config.HTTPS_PROXY,
      noProxy: config.NO_PROXY,
    })
  : ssrfAgent;
