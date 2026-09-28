/**
 * 运行时配置存取（SystemSetting 表，key-value）。
 *
 * 管理台写、服务端热读取——不缓存到进程内存，调用方每次现读，
 * 保证改完即时生效。读取失败（表未建 / DB 不可用）时由调用方兜底默认值，
 * 不让配置读取故障拖垮主流程。
 */
import { prisma } from './prisma.js';
import { logger } from '../utils/logger.js';

/** 任务并发默认值（SystemSetting 未配置或读取失败时使用） */
export const DEFAULT_TASK_CONCURRENCY_PER_KEY = 3;
export const DEFAULT_TASK_CONCURRENCY_GLOBAL = 10;

export const SETTING_KEY_TASK_PER_KEY = 'taskConcurrencyPerKey';
export const SETTING_KEY_TASK_GLOBAL = 'taskConcurrencyGlobal';

/** 读单个配置项；不存在返回 null */
export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}

/** 读多个配置项（一次查询）；返回缺失项为 undefined 的映射 */
export async function getSettings(keys: string[]): Promise<Map<string, string>> {
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: keys } } });
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** 写配置项（upsert） */
export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

/** 读全部配置项（管理台设置页用） */
export async function listSettings(): Promise<Record<string, string>> {
  const rows = await prisma.systemSetting.findMany();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/**
 * 解析为 ≥1 的整数；非法值返回 null（调用方走默认）。
 */
function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * 任务并发上限（每 Key / 全局）。
 *
 * 读取失败（DB 不可用 / 表未迁移）时记警告并返回默认值——
 * 任务系统不能因配置读取故障而拒绝工作。
 */
export async function getTaskConcurrency(): Promise<{ perKey: number; global: number }> {
  try {
    const map = await getSettings([SETTING_KEY_TASK_PER_KEY, SETTING_KEY_TASK_GLOBAL]);
    return {
      perKey:
        parsePositiveInt(map.get(SETTING_KEY_TASK_PER_KEY)) ?? DEFAULT_TASK_CONCURRENCY_PER_KEY,
      global:
        parsePositiveInt(map.get(SETTING_KEY_TASK_GLOBAL)) ?? DEFAULT_TASK_CONCURRENCY_GLOBAL,
    };
  } catch (err) {
    logger.warn({ err }, '读取任务并发配置失败，使用默认值');
    return { perKey: DEFAULT_TASK_CONCURRENCY_PER_KEY, global: DEFAULT_TASK_CONCURRENCY_GLOBAL };
  }
}
