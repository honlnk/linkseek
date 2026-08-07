-- LlmProvider 表：存储 LLM 供应商配置（用于 web_fetch_answer / web_search_answer 工具）
-- 对应 Prisma schema 中的 LlmProvider model

CREATE TABLE `LlmProvider` (
  `id` varchar(191) NOT NULL,
  `name` varchar(191) NOT NULL,
  `protocol` varchar(191) NOT NULL,
  `baseUrl` varchar(191) NOT NULL,
  `apiKey` varchar(191) NOT NULL,
  `model` varchar(191) NOT NULL,
  `models` varchar(191) NOT NULL DEFAULT '[]',
  `enabled` boolean NOT NULL DEFAULT true,
  `isDefault` boolean NOT NULL DEFAULT false,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 按启用状态建索引（listProviders / registerTools 查询用）
CREATE INDEX `LlmProvider_enabled_idx` ON `LlmProvider`(`enabled`);
