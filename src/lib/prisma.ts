import { PrismaClient } from '../generated/prisma-client/index.js';

/**
 * PrismaClient 单例。
 *
 * 用 globalThis 缓存实例，防止 tsx watch 热重载时重复创建 PrismaClient
 * （会触发 "Too many PrismaClient instances" 警告并耗尽连接池）。
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
