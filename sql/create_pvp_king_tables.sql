CREATE TABLE IF NOT EXISTS `pvp_king_stats` (
  `user_id` varchar(32) NOT NULL,
  `king_name` varchar(100) NOT NULL,
  `total_wins` int(11) DEFAULT 0,
  `total_crown_losses` int(11) DEFAULT 0,
  `current_streak` int(11) DEFAULT 0,
  `longest_streak` int(11) DEFAULT 0,
  `first_crowned` datetime DEFAULT NULL,
  `crowned_at` datetime DEFAULT NULL,
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `pvp_king_history` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `king_id` varchar(32) NOT NULL,
  `king_name` varchar(100) NOT NULL,
  `type` enum('crown','defense') NOT NULL,
  `total_wins_after` int(11) NOT NULL,
  `streak_after` int(11) NOT NULL,
  `longest_streak_after` int(11) NOT NULL,
  `last_crowned` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `sync_event_id` varchar(64) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_pvp_history_sync_event` (`sync_event_id`),
  KEY `king_id` (`king_id`),
  KEY `created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `pvp_king_cooldowns` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `challenger_id` varchar(32) NOT NULL,
  `challenger_name` varchar(100) NOT NULL,
  `king_id` varchar(32) NOT NULL,
  `king_name` varchar(100) NOT NULL,
  `last_challenge` datetime DEFAULT current_timestamp(),
  `notify_on_expire` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_user` (`challenger_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
