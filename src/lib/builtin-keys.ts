import { createHash, randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';
import { logger } from '../utils/logger.js';

/**
 * 内置伪 Key：公开 REST 绿灯通道（/v1/search、/v1/fetch）的匿名调用量
 * 统一记到这个 Key 名下，管理台的总量、工具分布、Key 排名、趋势图
 * 即可像普通 Key 一样覆盖 NovAI 的用量。
 *
 * 约定：
 * - id 固定，前端据此识别内置行（创建时间显示 ---、不提供删除）
 * - 无对应明文 token：tokenHash 是随机散列，鉴权永远不可能命中该行
 * - 删除接口对该 id 返回 403
 */
export const BUILTIN_NOVAI_KEY_ID = 'novai-greenlight';

/**
 * 启动时确保内置 Key 行存在（幂等）。失败只告警不阻断启动——
 * 行缺失时匿名流量照常服务，只是用量不进管理台。
 */
export async function ensureBuiltinKeys(): Promise<void> {
  try {
    const existing = await prisma.apiKey.findUnique({
      where: { id: BUILTIN_NOVAI_KEY_ID },
      select: { id: true },
    });
    if (existing) return;

    await prisma.apiKey.create({
      data: {
        id: BUILTIN_NOVAI_KEY_ID,
        name: 'NovAI',
        tokenPrefix: 'NovAI',
        tokenHash: `builtin-${createHash('sha256').update(randomUUID()).digest('hex')}`,
        enabled: true,
      },
    });
    logger.info('内置 NovAI 用量 Key 已就绪');
  } catch (err) {
    logger.warn({ err }, '内置 NovAI 用量 Key 初始化失败（用量暂不进管理台，不影响服务）');
  }
}
