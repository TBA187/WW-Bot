# Operations and configuration

[Return to the README](../README.md).

## Storage and database recovery

Database credentials belong in `.env`; server and feature configuration belongs in [config.json](../config.json). Apply the relevant schemas from [sql/](../sql/) before enabling a feature.

| `STORAGE_MODE` | Behavior |
| --- | --- |
| `auto` | Use MySQL when available; features with JSON recovery support save locally during outages and synchronize on recovery. |
| `mysql` | Prefer MySQL, retaining JSON recovery for features that support it. |
| `json` | Use local JSON in features that support this mode, without synchronizing their state to MySQL. |

JSON mode does not provide a complete database replacement. Scouting uses MySQL, and rank/leaderboard queries need verified database totals. Pending XP awards and activity counters are persisted before database writes and replayed after recovery; SQL receipts prevent an uncertain retry from applying the same operation twice.

Optional database connection settings:

| Environment variable | Default |
| --- | --- |
| `DB_CONNECT_TIMEOUT_MS` | `10000` |
| `DB_KEEPALIVE_DELAY_MS` | `30000` |
| `DB_RETRY_COOLDOWN_MS` | `5000` |
| `DB_RETRY_MAX_COOLDOWN_MS` | `60000` |
| `DB_STATUS_LOG_INTERVAL_MS` | `300000` |

Shared connection retry backoff limits repeated connection attempts during outages. Recovery-capable features retain their pending writes until synchronization succeeds.

## Server configuration

| Configuration | Purpose |
| --- | --- |
| `guildId`, `botTimezone` | Command-registration guild and calendar timezone. The current timezone is `Etc/UTC`. |
| `leaderRoleID`, `adminRoleID`, `officerRoleID` | Staff access to message editing, scouting review and other administration tools. |
| `goldRoleID`, `silverRoleID` | Game-server selection roles. |
| `logChannelID`, `ignoredLogChannels` | Audit destination and channels excluded from applicable audit delivery. |
| `blockedEditBotMsgChannels` | Channels where bot-message editing is blocked. |
| `pvpScoutingGoldChannelID`, `pvpScoutingSilverChannelID` | Separate scout-report source channels. |
| `pvpKingChannelID`, `pvpKingRoleID`, `historyThreadID` | Gold PvP King channel, crown role and history destination. |
| `pvpKingSilverChannelID`, `pvpKingSilverRoleID`, `historySilverThreadID` | Silver PvP King channel, crown role and history destination. |
| `dungeonChannelID`, `dungeonRoleID`, `giveawayChannelID` | Recruitment and giveaway destinations. |
| `officerChannelID`, `courtHouseChannelID` | Guild application alerts and voting polls. |
| `ownerID` | Owner-only forum review alerts and shop notifications. |

The invoking PvP King channel selects the corresponding crown, challenge state, history and notifications. Message-builder previews remain private until the owner confirms sending or saving.

## PvP King events

Configure events under `pvpKingEvents.gold` or `pvpKingEvents.silver`, then restart the bot. Each server has its own winner, streak requirement and reward.

Example value for `pvpKingEvents`:

```json
{
  "gold": {
    "enabled": true,
    "id": "gold-winter-2026",
    "name": "Gold Winter PvP King Challenge",
    "startDate": "2026-11-01T00:00:00Z",
    "endDate": null,
    "targetStreak": 10,
    "rewardCoinCapsules": 3,
    "announcementChannelID": "YOUR_ANNOUNCEMENT_CHANNEL_ID",
    "mentionEveryone": false
  },
  "silver": null
}
```

Use a stable, unique event ID. `/pvp_event` displays progress and finished results. `/pvp_crown` announces a winner and uses the event ID to recognize an existing announcement after a restart.

## Forum monitors and scouting

Guild applications use `forumGuildApplicationPage` and are checked every ten minutes. The initial scan establishes a baseline; later valid applications notify Officers and can create a 24-hour Court House poll. Voting reminders occur after 12 and 18 hours when fewer than half of current Officers have voted. Configure `forumGuildApplicationCooldownHours` to filter repeat applicants; `0` disables that filtering. Apply [the application schema](../sql/create_guild_applications_table.sql) before enabling the monitor.

Forum shop notifications use `tbaProForumShop`, `tbaProDungeonShop` and `tbaProForumNotifications` (`1` enables delivery, `0` disables it). The monitors check every twelve minutes, establish a silent initial baseline and share processed-post checkpoints through MySQL. New replies are sent to `ownerID`.

Scout reports that fail validation receive correction suggestions and a one-hour correction window before staff escalation. Correction deadlines survive restarts. Gold and Silver reports remain in separate archives; Cross Server searches read both. The saved autocomplete snapshots can be rebuilt from the database.

A guild-application preview is available without Discord delivery:

```sh
node scripts/test_guild_application_notification.js
```

The script's `--send` and other `--send-*` modes publish previews to its configured test destinations. Review the options in [the script](../scripts/test_guild_application_notification.js) before using a delivery mode.

## Runtime files and backups

Stop the old bot instance before moving hosts. Back up MySQL and preserve the feature state below, particularly pending updates that have not reached the database.

| Path under `data/` | Purpose |
| --- | --- |
| `dungeon_runs.json` | Dungeon recovery state. |
| `pvp_king_data.json`, `pvp_king_silver_data.json` | Gold and Silver PvP King recovery state. |
| `giveaways.json` | Giveaway metadata, entries, draw history and pending updates. |
| `xp_pending.json` | Pending XP/activity operations and saved special-track settings. Copy pending operations before starting a replacement host. |
| `guild_settings.json` | Guild settings recovery mirror. |
| `notifications.json` | Subscription settings and recovery state. |
| `guild_applications.json` | Forum scan checkpoint, application records and pending delivery state. |
| `tba_forum_shops.json` | Forum shop recovery checkpoints. |
| `scout-autocomplete-cache.json`, `scout-autocomplete-silver-cache.json` | Rebuildable Gold and Silver search indexes. |
| `tesseract-cache/` | Reusable OCR language data. |
| `logs/ww-YYYY-MM.log` | Runtime diagnostic output. |

Runtime state files are ignored by Git; bundled reference data under `data/` is tracked. Avoid editing state files while the bot is running.

## Runtime logs

Standard output, errors and full stack traces are appended to UTF-8 monthly files. Log entries use UTC timestamps in `[YYYY-MM-DD HH:MM:SS]` format; component labels remain visible. Grouped command inventories use one timestamp on their header. Monthly filename rollover follows `botTimezone`.

Maintenance runs at startup, rollover and every hour. Defaults retain the newest 12 matching monthly files, including the active month. Completed months are removed oldest first when matching logs exceed 100 MiB or free disk space falls below 100 MiB; low-space recovery targets 150 MiB free. The active monthly file is always retained.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `BOT_LOG_PATH` | `data/logs/ww.log` | Base filename; `-YYYY-MM` is inserted before the extension. |
| `BOT_LOG_RETENTION_MONTHS` | `12` | Maximum retained monthly files, including the active file. |
| `BOT_LOG_MAX_TOTAL_MIB` | `100` | Matching log storage cap; `0` disables the cap. |
| `BOT_LOG_MIN_FREE_MIB` | `100` | Low-free-space cleanup trigger; `0` disables it. |
| `BOT_LOG_CLEANUP_TARGET_FREE_MIB` | `150` | Cleanup target, never lower than the trigger threshold. |

Invalid values use defaults. Retention is at least one file; storage values are at least zero. Unrelated files are left alone. If file logging is unavailable, console logging continues.
