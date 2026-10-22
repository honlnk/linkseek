import { getSetting, setSetting } from '../../lib/settings.js';
import { logger } from '../../utils/logger.js';
import type { SearchAttempt, SearchResult } from '../provider.js';
import { devinEngine } from './devin.js';
import { exaEngine } from './exa.js';
import { deepseekEngine } from './deepseek.js';
import { braveEngine } from './brave.js';
import type { CommercialEngine, CommercialEngineStatus } from './types.js';

/**
 * 商业兜底引擎管理器。
 *
 * 引擎列表存 SystemSetting（JSON 数组，顺序即兜底尝试顺序），后台可增删/启停/排序；
 * 空或未设置 = 兜底整体关闭（默认状态，未配置的部署完全无感）。
 * 单引擎失败静默继续下一个；全部失败不改变对外行为（由 fallback.ts 兜底语义保证）。
 */

export const SETTING_KEY_COMMERCIAL_ENGINES = 'commercialEngines';

/** 引擎列表条目 */
export interface CommercialEngineEntry {
  id: string;
  enabled: boolean;
}

export interface CommercialFallbackOutcome {
  results: SearchResult[];
  /** 商业兜底尝试记录（kind='commercial'，由调用方并入 diagnostics.attempts） */
  attempts: SearchAttempt[];
  /** 命中的引擎 id */
  hitEngine?: string;
}

/** 引擎列表读取（测试注入点） */
export type EnginesConfigLoader = () => Promise<CommercialEngineEntry[]>;

/** 从 SystemSetting 读引擎列表；未设置/损坏一律视为关闭（不因配置损坏拖垮搜索主链路） */
export async function loadEngineEntries(): Promise<CommercialEngineEntry[]> {
  const raw = await getSetting(SETTING_KEY_COMMERCIAL_ENGINES);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: CommercialEngineEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const { id, enabled } = item as Record<string, unknown>;
      if (typeof id === 'string' && id && typeof enabled === 'boolean') {
        entries.push({ id, enabled });
      }
    }
    return entries;
  } catch {
    logger.warn('commercialEngines 配置损坏，商业兜底视为关闭');
    return [];
  }
}

export class CommercialManager {
  constructor(
    private readonly registry: Record<string, CommercialEngine>,
    private readonly loadConfig: EnginesConfigLoader = loadEngineEntries,
  ) {}

  /** 注册表里是否有该引擎 id（PUT 校验用） */
  has(id: string): boolean {
    return id in this.registry;
  }

  /** 后台展示用：全部已注册引擎及其状态 */
  async catalog(): Promise<
    Array<{ id: string; name: string; status: CommercialEngineStatus }>
  > {
    return Promise.all(
      Object.values(this.registry).map(async (engine) => ({
        id: engine.id,
        name: engine.name,
        status: await engine.status(),
      })),
    );
  }

  /** 按列表顺序逐个尝试；命中即返回，单引擎异常静默继续 */
  async runFallback(query: string, maxResults: number): Promise<CommercialFallbackOutcome> {
    let entries: CommercialEngineEntry[];
    try {
      entries = await this.loadConfig();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, '读取商业兜底引擎列表失败');
      return { results: [], attempts: [] };
    }

    const attempts: SearchAttempt[] = [];
    for (const entry of entries) {
      if (!entry.enabled) continue;
      const engine = this.registry[entry.id];
      if (!engine) {
        attempts.push({
          label: `商业兜底:${entry.id}`,
          kind: 'commercial',
          resultCount: 0,
          error: '未知引擎（列表 id 无对应实现），已跳过',
        });
        continue;
      }
      let usable: boolean;
      try {
        usable = await engine.available();
      } catch {
        usable = false;
      }
      if (!usable) {
        attempts.push({
          label: `商业兜底:${engine.id}`,
          kind: 'commercial',
          resultCount: 0,
          error: '凭证缺失或已失效，跳过',
        });
        continue;
      }
      try {
        const results = await engine.search(query, maxResults);
        attempts.push({
          label: `商业兜底:${engine.id}`,
          kind: 'commercial',
          resultCount: results.length,
        });
        if (results.length > 0) {
          logger.info({ query, engine: engine.id, count: results.length }, '商业兜底命中');
          return { results, attempts, hitEngine: engine.id };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        attempts.push({
          label: `商业兜底:${engine.id}`,
          kind: 'commercial',
          resultCount: -1,
          error: message,
        });
        logger.warn({ query, engine: engine.id, err: message }, '商业兜底引擎失败，继续尝试下一个');
      }
    }
    return { results: [], attempts };
  }
}

/**
 * 进程内单例。新增引擎 = 实现类 + 在此登记（设计方案 4.5）。
 * 注意：registry 里的引擎 id 必须与后台 commercialEngines 列表里的 id 一致；
 * 注册顺序即后台目录展示顺序与默认优先级（Devin → Exa → DeepSeek → Brave，
 * 免费额度优先、需绑卡的 Brave 垫底；已保存的引擎列表顺序仍以用户排列为准）。
 */
export const commercialManager = new CommercialManager({
  devin: devinEngine,
  exa: exaEngine,
  deepseek: deepseekEngine,
  brave: braveEngine,
});

/** fallback.ts 的调用入口（屏蔽单例细节） */
export function runCommercialFallback(
  query: string,
  maxResults: number,
): Promise<CommercialFallbackOutcome> {
  return commercialManager.runFallback(query, maxResults);
}

/** 保存引擎列表（管理后台 PUT 用） */
export async function saveEngineEntries(entries: CommercialEngineEntry[]): Promise<void> {
  await setSetting(SETTING_KEY_COMMERCIAL_ENGINES, JSON.stringify(entries));
}
