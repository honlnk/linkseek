-- UsageLog 表：新增 AI token 用量与成本字段（用于 web_fetch_answer / web_search_answer 工具）
-- 非 AI 工具调用这些字段保持默认 0 / null，不影响现有统计
ALTER TABLE `UsageLog`
  ADD COLUMN `providerId` varchar(191) NULL,
  ADD COLUMN `model` varchar(191) NULL,
  ADD COLUMN `promptTokens` integer NOT NULL DEFAULT 0,
  ADD COLUMN `completionTokens` integer NOT NULL DEFAULT 0,
  ADD COLUMN `cacheHitTokens` integer NOT NULL DEFAULT 0,
  ADD COLUMN `cacheMissTokens` integer NOT NULL DEFAULT 0,
  ADD COLUMN `cacheWriteTokens` integer NOT NULL DEFAULT 0,
  ADD COLUMN `cost` double NOT NULL DEFAULT 0;

-- 按 Provider 维度聚合金额用索引
CREATE INDEX `UsageLog_providerId_idx` ON `UsageLog`(`providerId`);

-- LlmProvider 表：新增价格配置列（JSON 字符串）
ALTER TABLE `LlmProvider`
  ADD COLUMN `pricing` varchar(191) NOT NULL DEFAULT '{}';
