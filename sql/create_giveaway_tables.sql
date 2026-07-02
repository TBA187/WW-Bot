CREATE TABLE IF NOT EXISTS giveaways (
  giveaway_id VARCHAR(96) NOT NULL,
  guild_id VARCHAR(32) DEFAULT NULL,
  channel_id VARCHAR(32) NOT NULL,
  message_id VARCHAR(32) DEFAULT NULL,
  name VARCHAR(256) DEFAULT NULL,
  prize VARCHAR(512) NOT NULL,
  host_text VARCHAR(256) DEFAULT NULL,
  host_user_id VARCHAR(32) DEFAULT NULL,
  created_by_id VARCHAR(32) DEFAULT NULL,
  created_by_name VARCHAR(128) DEFAULT NULL,
  winners_total INT NOT NULL DEFAULT 1,
  required_role_id VARCHAR(32) DEFAULT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  starts_at DATETIME(6) NOT NULL,
  ends_at DATETIME(6) NOT NULL,
  ended_at DATETIME(6) DEFAULT NULL,
  deleted_at DATETIME(6) DEFAULT NULL,
  color_hex VARCHAR(7) NOT NULL DEFAULT '#39FF14',
  thumbnail_url TEXT DEFAULT NULL,
  winner_user_ids LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (JSON_VALID(winner_user_ids)),
  giveaway_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (JSON_VALID(giveaway_json)),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (giveaway_id),
  UNIQUE KEY uq_giveaway_message_id (message_id),
  KEY idx_giveaway_status_ends_at (status, ends_at),
  KEY idx_giveaway_channel_id (channel_id),
  KEY idx_giveaway_created_by_id (created_by_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS giveaway_entries (
  giveaway_id VARCHAR(96) NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  user_name VARCHAR(128) DEFAULT NULL,
  joined_at DATETIME(6) NOT NULL,
  left_at DATETIME(6) DEFAULT NULL,
  entry_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (JSON_VALID(entry_json)),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (giveaway_id, user_id),
  KEY idx_giveaway_active_entries (giveaway_id, left_at),
  KEY idx_giveaway_user_id (user_id),
  CONSTRAINT fk_giveaway_entry
    FOREIGN KEY (giveaway_id) REFERENCES giveaways(giveaway_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS giveaway_draws (
  draw_id VARCHAR(128) NOT NULL,
  giveaway_id VARCHAR(96) NOT NULL,
  draw_type VARCHAR(32) NOT NULL,
  drawn_by_id VARCHAR(32) DEFAULT NULL,
  drawn_at DATETIME(6) NOT NULL,
  eligible_count INT NOT NULL DEFAULT 0,
  winner_user_ids LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (JSON_VALID(winner_user_ids)),
  draw_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (JSON_VALID(draw_json)),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (draw_id),
  KEY idx_giveaway_draws (giveaway_id, drawn_at),
  KEY idx_giveaway_draw_type (draw_type),
  CONSTRAINT fk_giveaway_draw
    FOREIGN KEY (giveaway_id) REFERENCES giveaways(giveaway_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
