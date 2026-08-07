/**
 * LLM Provider 数据访问层。
 *
 * 基于 Prisma（MySQL）存储 Provider 配置。
 * 列表/详情返回时 apiKey 做掩码处理；只有 getDefaultProvider/resolveProvider 返回明文。
 */
import { prisma } from '../lib/prisma.js';
import type { Protocol, ConnectionConfig } from './types.js';
import { getAdapter } from './index.js';
import { logger } from '../utils/logger.js';

/** Provider 完整配置（含明文 apiKey，仅供后端调用 LLM 用） */
export interface ProviderConfig {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  models: string[];
  enabled: boolean;
  isDefault: boolean;
}

/** Provider 列表项（apiKey 掩码，供 API 返回前端用） */
export interface ProviderListItem {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKeyMasked: string;
  model: string;
  models: string[];
  enabled: boolean;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** 创建/更新 Provider 的输入 */
export interface ProviderInput {
  name?: string;
  protocol?: Protocol;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  models?: string[];
  enabled?: boolean;
  isDefault?: boolean;
}

/** 掩码 apiKey：保留最后 4 位 */
function maskApiKey(key: string): string {
  if (key.length <= 4) return '***';
  return `***${key.slice(-4)}`;
}

/** Prisma 记录 → ProviderConfig（含解析 models JSON） */
function toConfig(row: {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  models: string;
  enabled: boolean;
  isDefault: boolean;
}): ProviderConfig {
  let models: string[] = [];
  try {
    models = JSON.parse(row.models) as string[];
  } catch {
    models = [];
  }
  return {
    ...row,
    protocol: row.protocol as Protocol,
    models,
  };
}

/** Prisma 记录 → ProviderListItem（apiKey 掩码） */
function toListItem(row: {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  models: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}): ProviderListItem {
  let models: string[] = [];
  try {
    models = JSON.parse(row.models) as string[];
  } catch {
    models = [];
  }
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol as Protocol,
    baseUrl: row.baseUrl,
    apiKeyMasked: maskApiKey(row.apiKey),
    model: row.model,
    models,
    enabled: row.enabled,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 获取默认 Provider（含明文 apiKey） */
export async function getDefaultProvider(): Promise<ProviderConfig | null> {
  const row = await prisma.llmProvider.findFirst({
    where: { isDefault: true, enabled: true },
  });
  return row ? toConfig(row) : null;
}

/** 获取默认 Provider ID（不论是否 enabled） */
export async function getDefaultProviderId(): Promise<string | null> {
  const row = await prisma.llmProvider.findFirst({
    where: { isDefault: true },
    select: { id: true },
  });
  return row?.id ?? null;
}

/** 按 ID 获取 Provider（含明文 apiKey） */
export async function getProvider(id: string): Promise<ProviderConfig | null> {
  const row = await prisma.llmProvider.findUnique({ where: { id } });
  return row ? toConfig(row) : null;
}

/**
 * 解析 Provider：name/id → default → null
 *
 * 查找顺序：
 * 1. 传入 model 参数时，按 Provider 名称（不区分大小写）或 ID 精确匹配
 *    - 命中且 enabled：返回该 Provider
 *    - 未命中：返回 null（让工具报错，引导 AI 调 list_models 查可用选项）
 * 2. 未传 model 参数：返回默认 Provider（可能为 null）
 *
 * 设计说明：传入 model 找不到时**不静默回退**到默认，否则 AI 无法感知故障切换的需求。
 */
export async function resolveProvider(idOrName?: string): Promise<ProviderConfig | null> {
  if (!idOrName) {
    return getDefaultProvider();
  }

  // 先按 ID 精确匹配（cuid）
  const byId = await prisma.llmProvider.findUnique({
    where: { id: idOrName },
  });
  if (byId) {
    const cfg = toConfig(byId);
    if (!cfg.enabled) {
      logger.warn({ requested: idOrName }, '指定的 LLM Provider 已禁用');
      return null;
    }
    return cfg;
  }

  // 再按名称不区分大小写匹配
  const byName = await prisma.llmProvider.findFirst({
    where: { name: { equals: idOrName } },
  });
  if (byName) {
    const cfg = toConfig(byName);
    if (!cfg.enabled) {
      logger.warn({ requested: idOrName }, '指定的 LLM Provider 已禁用');
      return null;
    }
    return cfg;
  }

  // 找不到时返回 null，让工具返回明确错误（不静默回退）
  logger.warn({ requested: idOrName }, '指定的 LLM Provider 不存在');
  return null;
}

/** 列出所有 Provider（apiKey 掩码） */
export async function listProviders(): Promise<ProviderListItem[]> {
  const rows = await prisma.llmProvider.findMany({
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toListItem);
}

/** 创建 Provider */
export async function createProvider(data: Required<Pick<ProviderInput, 'name' | 'protocol' | 'baseUrl' | 'apiKey' | 'model'>> & Partial<ProviderInput>): Promise<ProviderConfig> {
  // 如果是第一个 Provider，自动设为默认
  const count = await prisma.llmProvider.count();
  const isFirst = count === 0;

  // 如果新建时设为默认，先取消其他默认标记
  if (data.isDefault || isFirst) {
    await prisma.llmProvider.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    });
  }

  const row = await prisma.llmProvider.create({
    data: {
      name: data.name,
      protocol: data.protocol,
      baseUrl: data.baseUrl,
      apiKey: data.apiKey,
      model: data.model,
      models: JSON.stringify(data.models ?? []),
      enabled: data.enabled ?? true,
      isDefault: data.isDefault ?? isFirst,
    },
  });

  logger.info({ providerId: row.id, name: row.name }, '创建 LLM Provider');
  return toConfig(row);
}

/** 更新 Provider（空 apiKey = 不修改） */
export async function updateProvider(id: string, data: ProviderInput): Promise<ProviderConfig> {
  const updateData: Record<string, unknown> = {};

  if (data.name !== undefined) updateData.name = data.name;
  if (data.protocol !== undefined) updateData.protocol = data.protocol;
  if (data.baseUrl !== undefined) updateData.baseUrl = data.baseUrl;
  if (data.model !== undefined) updateData.model = data.model;
  if (data.enabled !== undefined) updateData.enabled = data.enabled;
  // apiKey 空字符串或 undefined = 不修改
  if (data.apiKey && data.apiKey.trim()) {
    updateData.apiKey = data.apiKey.trim();
  }
  if (data.models !== undefined) {
    updateData.models = JSON.stringify(data.models);
  }

  // 设为默认：先取消其他默认
  if (data.isDefault) {
    await prisma.llmProvider.updateMany({
      where: { isDefault: true, NOT: { id } },
      data: { isDefault: false },
    });
    updateData.isDefault = true;
  }

  const row = await prisma.llmProvider.update({
    where: { id },
    data: updateData,
  });

  logger.info({ providerId: id }, '更新 LLM Provider');
  return toConfig(row);
}

/** 删除 Provider（拒绝删除默认 Provider） */
export async function deleteProvider(id: string): Promise<void> {
  const provider = await prisma.llmProvider.findUnique({ where: { id } });
  if (!provider) throw new Error('Provider 不存在');
  if (provider.isDefault) throw new Error('不能删除默认 Provider，请先设置其他 Provider 为默认');

  await prisma.llmProvider.delete({ where: { id } });
  logger.info({ providerId: id }, '删除 LLM Provider');
}

/** 设默认 Provider */
export async function setDefaultProvider(id: string): Promise<void> {
  const provider = await prisma.llmProvider.findUnique({ where: { id } });
  if (!provider) throw new Error('Provider 不存在');

  await prisma.$transaction([
    prisma.llmProvider.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    }),
    prisma.llmProvider.update({
      where: { id },
      data: { isDefault: true },
    }),
  ]);

  logger.info({ providerId: id }, '设置默认 LLM Provider');
}

/**
 * 从上游拉取模型列表并缓存到数据库。
 * @param id Provider ID；不传时用临时凭据（preview 模式）
 * @param tempCreds 临时凭据（preview 模式用）
 * @returns 模型列表
 */
export async function fetchAndCacheModels(
  id: string,
  tempCreds?: { baseUrl: string; apiKey: string; protocol: Protocol },
): Promise<string[]> {
  let conn: { baseUrl: string; apiKey: string; protocol: Protocol };

  if (tempCreds) {
    conn = tempCreds;
  } else {
    const provider = await getProvider(id);
    if (!provider) throw new Error('Provider 不存在');
    conn = { baseUrl: provider.baseUrl, apiKey: provider.apiKey, protocol: provider.protocol };
  }

  const adapter = getAdapter(conn.protocol);
  const models = await adapter.listModels(conn);

  // 有 id 时缓存到数据库
  if (id && !tempCreds) {
    await prisma.llmProvider.update({
      where: { id },
      data: { models: JSON.stringify(models) },
    });
    logger.info({ providerId: id, count: models.length }, '拉取并缓存模型列表');
  }

  return models;
}

/**
 * 将 ProviderConfig 转为 LLM 适配器的 ConnectionConfig。
 */
export function toConnectionConfig(provider: ProviderConfig): ConnectionConfig {
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    protocol: provider.protocol,
  };
}
