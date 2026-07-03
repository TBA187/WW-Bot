CREATE TABLE IF NOT EXISTS `xp_user_levels` (
  `user_id` varchar(32) NOT NULL,
  `guild_id` varchar(32) NOT NULL,
  `username` varchar(100) DEFAULT NULL,
  `xp_type` varchar(50) NOT NULL DEFAULT 'global',
  `xp_date` timestamp NULL DEFAULT NULL,
  `xp_amount` bigint(20) NOT NULL DEFAULT 0,
  `level` int(11) NOT NULL DEFAULT 0,
  `message_xp` bigint(20) NOT NULL DEFAULT 0,
  `reaction_xp` bigint(20) NOT NULL DEFAULT 0,
  `command_xp` bigint(20) NOT NULL DEFAULT 0,
  `voice_xp` bigint(20) NOT NULL DEFAULT 0,
  `messages_sent` int(11) NOT NULL DEFAULT 0,
  `total_messages_sent` int(11) NOT NULL DEFAULT 0,
  `reactions_added` int(11) NOT NULL DEFAULT 0,
  `total_reactions_added` int(11) NOT NULL DEFAULT 0,
  `commands_used` int(11) NOT NULL DEFAULT 0,
  `total_commands_used` int(11) NOT NULL DEFAULT 0,
  `voice_minutes` int(11) NOT NULL DEFAULT 0,
  `total_voice_minutes` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`user_id`,`guild_id`,`xp_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `xp_channel_tracks` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `role_ids` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`role_ids`)),
  `channel_ids` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`channel_ids`)),
  `level_rewards` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`level_rewards`)),
  `send_level_up_msg` tinyint(1) DEFAULT 1,
  `tag_user_level_up_msg` tinyint(1) DEFAULT 1,
  `cooldown_overrides` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`cooldown_overrides`)),
  `color` varchar(7) DEFAULT '#5865F2',
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `xp_rewards` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `level` int(11) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `role_id` varchar(32) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_level` (`level`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
