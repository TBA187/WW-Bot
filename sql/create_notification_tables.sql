CREATE TABLE IF NOT EXISTS `guild_notification_settings` (
  `guild_id` varchar(32) NOT NULL,
  `notification_key` varchar(64) NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  PRIMARY KEY (`guild_id`, `notification_key`),
  KEY `idx_guild_notification_settings_created_at` (`guild_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `user_notification_subscriptions` (
  `guild_id` varchar(32) NOT NULL,
  `notification_key` varchar(64) NOT NULL,
  `user_id` varchar(32) NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  PRIMARY KEY (`guild_id`, `notification_key`, `user_id`),
  KEY `idx_user_notification_subscriptions_enabled` (`guild_id`, `notification_key`, `enabled`),
  KEY `idx_user_notification_subscriptions_user` (`guild_id`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
