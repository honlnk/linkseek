import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * 绿灯匿名配额（FreeUsage 表）。
 *
 * 设计（见 NovAI《内置联网搜索计划》决策 7）：
 * - 每身份（cid:<clientId>，无 clientId 时退化为 ip:<ip>）每天加权上限 PUBLIC_API_DAILY_LIMIT（50）；
 * - 另有 IP 总闸 ip:<ip> 每天 PUBLIC_API_IP_DAILY_LIMIT（200），防批量换 clientId；
 * - 加权计次：普通搜索/HTTP 抓取计 1，命中浏览器渲染计 PUBLIC_API_RENDER_COST（2）。
 *
 * 扣减采用「执行前查余量 + 执行后按实际权重扣」：
 * 渲染升级发生在请求中段，事前无法知道权重；余量只剩 1 时升级渲染会透支 1 次，可接受且自限。
 */

/** 服务器本地时区的日期桶 YYYY-MM-DD（免费额度「每天」按服务器本地日界重置） */
function todayBucket(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export interface QuotaKeys {
  /** 身份配额键：cid:<clientId> 或 ip:<ip> */
  identityKey: string;
  /** IP 总闸键：ip:<ip> */
  ipKey: string;
}

/** clientId 合法形态：UUID/短随机串，防超长键刷爆配额表 */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * 从请求解析配额键。
 * clientId 不合法（缺失/超长/含异常字符）时静默退化为 IP 键——
 * 它是防君子不防小人的辅助信号，不值得为它拒绝请求。
 */
export function resolveQuotaKeys(clientId: string | undefined, ip: string | undefined): QuotaKeys {
  const cleanClientId = clientId?.trim();
  const safeIp = ip || 'unknown';
  return {
    identityKey: cleanClientId && CLIENT_ID_PATTERN.test(cleanClientId) ? `cid:${cleanClientId}` : `ip:${safeIp}`,
    ipKey: `ip:${safeIp}`,
  };
}

async function readCount(day: string, quotaKey: string): Promise<number> {
  const row = await prisma.freeUsage.findUnique({
    where: { day_quotaKey: { day, quotaKey } },
    select: { count: true },
  });
  return row?.count ?? 0;
}

/**
 * 执行前检查：身份键与 IP 总闸都至少还剩 1 次余量才放行。
 * fail-open：数据库故障时记日志并放行（搜索后端不依赖本库，不让配额库故障拖垮绿灯）。
 */
export async function quotaAvailable(keys: QuotaKeys): Promise<boolean> {
  const day = todayBucket();
  try {
    const [identityUsed, ipUsed] = await Promise.all([
      readCount(day, keys.identityKey),
      readCount(day, keys.ipKey),
    ]);
    return (
      identityUsed < config.PUBLIC_API_DAILY_LIMIT && ipUsed < config.PUBLIC_API_IP_DAILY_LIMIT
    );
  } catch (err) {
    logger.error({ err, keys }, '配额查询失败（fail-open 放行）');
    return true;
  }
}

/**
 * 执行后按实际权重扣减。原子 upsert 递增；同样 fail-open。
 * 超限请求也会被计入（quotaAvailable 拦截前的消耗已发生），自我惩罚刷量行为。
 */
export async function consumeQuota(keys: QuotaKeys, cost: number): Promise<void> {
  const day = todayBucket();
  const consume = (quotaKey: string) =>
    prisma.freeUsage.upsert({
      where: { day_quotaKey: { day, quotaKey } },
      create: { day, quotaKey, count: cost },
      update: { count: { increment: cost } },
    });
  try {
    await Promise.all([consume(keys.identityKey), consume(keys.ipKey)]);
  } catch (err) {
    logger.error({ err, keys, cost }, '配额扣减失败（fail-open）');
  }
}
