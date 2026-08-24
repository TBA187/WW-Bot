CREATE TABLE IF NOT EXISTS `bot_instance_leases` (
    `lease_key` VARCHAR(191) NOT NULL,
    `owner_id` VARCHAR(191) NOT NULL,
    `acquired_at` DATETIME(3) NOT NULL,
    `heartbeat_at` DATETIME(3) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    PRIMARY KEY (`lease_key`),
    KEY `idx_bot_instance_leases_expires_at` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `tba_forum_shop_checkpoints` (
    `shop_key` VARCHAR(64) NOT NULL,
    `topic_url` VARCHAR(1000) NOT NULL,
    `initialized` TINYINT(1) NOT NULL DEFAULT 0,
    `last_seen_post_id` VARCHAR(32) NULL,
    `last_page` INT UNSIGNED NOT NULL DEFAULT 1,
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`shop_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
