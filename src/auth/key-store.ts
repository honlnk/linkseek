import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { config, type KeyRecord } from '../config.js';
import { logger } from '../utils/logger.js';
import { prisma } from '../lib/prisma.js';

/**
 * KeyStore 抽象 —— 第一阶段用 EnvKeyStore（环境变量内存），
 * 第二阶段用 PrismaKeyStore（MySQL）。两者实现同一接口。
 */
export interface KeyStore {
  /** 按明文 token 查找，命中且 enabled 返回记录，否则返回 null */
  findByToken(token: string): Promise<(KeyRecord & { id: string }) | null>;
}

/** SHA-256 哈希（十六进制） */
function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 常量时间比对两个十六进制哈希字符串 */
function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 内存 KeyStore：从环境变量加载，明文经 SHA-256 哈希后保存。
 * 仅在无数据库时兜底使用。
 */
export class EnvKeyStore implements KeyStore {
  private readonly entries: Map<string, KeyRecord & { id: string }>;

  constructor(records: KeyRecord[]) {
    this.entries = new Map();
    for (const r of records) {
      const hash = sha256(r.key);
      if (this.entries.has(hash)) {
        logger.warn({ name: r.name }, 'API_KEYS 中存在重复的 key，后者覆盖前者');
      }
      this.entries.set(hash, { ...r, id: hash.slice(0, 8) });
    }
  }

  async findByToken(token: string): Promise<(KeyRecord & { id: string }) | null> {
    const tokenHash = sha256(token);
    for (const [storedHash, record] of this.entries) {
      if (safeEqualHex(tokenHash, storedHash)) {
        return record.enabled === false ? null : record;
      }
    }
    return null;
  }
}

/**
 * 数据库 KeyStore：从 MySQL 查询，tokenHash 作为唯一索引。
 */
export class PrismaKeyStore implements KeyStore {
  async findByToken(token: string): Promise<(KeyRecord & { id: string }) | null> {
    const row = await prisma.apiKey.findUnique({
      where: { tokenHash: sha256(token) },
    });
    if (!row || !row.enabled) return null;
    return {
      id: row.id,
      name: row.name,
      key: token, // verifier 不直接用明文，这里填上保持接口一致
      enabled: row.enabled,
    };
  }
}

/**
 * 工厂：根据是否配置 DATABASE_URL 决定用哪个 KeyStore。
 * DATABASE_URL 存在且非空 → PrismaKeyStore；否则 → EnvKeyStore（向后兼容）。
 */
export function createKeyStore(): KeyStore {
  if (config.DATABASE_URL) {
    logger.info('KeyStore: 使用数据库（Prisma）');
    return new PrismaKeyStore();
  }
  logger.info({ count: config.API_KEYS.length }, 'KeyStore: 使用环境变量（内存）');
  return new EnvKeyStore(config.API_KEYS);
}

/**
 * 生成新 Key：wf_ + 24 字节随机 hex。
 * 返回 { plaintext, tokenHash, tokenPrefix }。
 */
export function generateApiKey(): { plaintext: string; tokenHash: string; tokenPrefix: string } {
  const random = randomBytes(24).toString('hex');
  const plaintext = `wf_${random}`;
  return {
    plaintext,
    tokenHash: sha256(plaintext),
    tokenPrefix: plaintext.slice(0, 12), // "wf_" + 前 9 位 hex
  };
}
