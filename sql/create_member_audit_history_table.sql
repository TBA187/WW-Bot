CREATE TABLE IF NOT EXISTS member_audit_history (
    guild_id VARCHAR(20) NOT NULL,
    user_id VARCHAR(20) NOT NULL,
    state_json JSON NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (guild_id, user_id),
    KEY member_audit_updated (updated_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
