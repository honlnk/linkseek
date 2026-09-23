-- CreateTable
CREATE TABLE `FreeUsage` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `day` VARCHAR(191) NOT NULL,
    `quotaKey` VARCHAR(191) NOT NULL,
    `count` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `FreeUsage_day_quotaKey_key`(`day`, `quotaKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
