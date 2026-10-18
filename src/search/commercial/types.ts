import type { SearchResult } from '../provider.js';

/**
 * 商业兜底引擎的统一抽象。
 *
 * 与 SearXNG 主链路解耦：降级链全空后由 manager 按后台列表逐个尝试，
 * 引擎自身负责凭证读取与失效熔断；新增引擎 = 实现本接口 + 在 manager 注册。
 */
export interface CommercialEngine {
  /** 引擎标识（SystemSetting commercialEngines 列表里的 id），如 'devin' / 'brave' */
  readonly id: string;
  /** 展示名（管理后台用） */
  readonly name: string;
  /** 配置齐全且凭证可用（未配置 / 已过期 / 熔断中均返回 false，调用方跳过） */
  available(): Promise<boolean>;
  /** 凭证状态摘要（管理后台展示；不暴露凭证明文） */
  status(): Promise<CommercialEngineStatus>;
  search(query: string, maxResults: number): Promise<SearchResult[]>;
}

/** 后台「搜索兜底」页展示的引擎状态 */
export interface CommercialEngineStatus {
  /** not_configured=未配置凭证 / ok=正常 / expired=凭证已过期 / invalid=凭证失效（鉴权被拒已熔断） */
  state: 'not_configured' | 'ok' | 'expired' | 'invalid';
  /** 凭证过期时间（ms 时间戳，能解析出时才有，如 Devin JWT exp），未知为 undefined */
  expiresAt?: number;
}
