# WW-Bot

WW-Bot is the White Walkers Discord bot. It handles XP tracking, level rewards, PvP King challenges, dungeon recruitment, giveaways, auto-role panels, welcome messages, and server audit logging.

## Requirements

- Node.js 20 or newer
- MySQL or MariaDB for production storage
- A Discord bot token with the required gateway intents enabled
- `Manage Roles`, `Send Messages`, `Embed Links`, `Attach Files`, and command permissions in the target server

Install dependencies:

```bash
npm install
```

Start the bot:

```bash
node index.js
```

Run checks and tests:

```bash
node --check index.js
npm test
```

## Configuration

Runtime secrets live in `.env`. The most important values are:

- `TOKEN`
- `CLIENT_ID`
- `DB_HOST`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `DB_PORT`
- `STORAGE_MODE`

`STORAGE_MODE` accepts:

- `auto`: use MySQL when available, fallback to local JSON during outages, then sync back.
- `mysql`: prefer MySQL, fallback to JSON when MySQL is down.
- `json`: only use local JSON files. This is useful for local testing and does not sync to MySQL.

Server IDs and feature IDs live in `config.json`, including:

- `botTimezone`: default bot timezone. Current value is `Etc/UTC`.
- `guildId`
- role IDs such as `leaderRoleID`, `adminRoleID`, `officerRoleID`, `pvpKingRoleID`, and `dungeonRoleID`
- channel IDs such as `botChannelID`, `logChannelID`, `pvpKingChannelID`, `dungeonChannelID`, and `giveawayChannelID`

## Database Setup

Ready-to-run SQL files are grouped by feature in `sql/`:

- `sql/create_dungeon_tables.sql`
- `sql/create_giveaway_tables.sql`
- `sql/create_guild_settings_table.sql`
- `sql/create_pvp_king_tables.sql`
- `sql/create_xp_level_tables.sql`

## Runtime Data

Local runtime state is stored in `data/` and ignored by Git.

- `data/dungeon_runs.json`: temporary dungeon fallback state.
- `data/pvp_king_data.json`: temporary PvP King fallback state.
- `data/giveaways.json`: temporary giveaway fallback state.
- `data/guild_settings.json`: mirror of guild settings, kept populated so XP/logging settings still load during a database outage.

The fallback files are not meant to be edited by hand while the bot is running.

## Feature Overview

XP and ranks:

- tracks global XP and special XP tracks
- supports messages, reactions, commands, and voice XP
- assigns level rewards and shows `/rank` and `/leaderboard`

PvP King:

- manages crown, challenge, cooldown, history, stats, leaderboard, reverse, and notifier flows
- uses MySQL transactions where multiple PvP database updates must succeed together
- falls back to JSON when MySQL is unavailable

Dungeon recruitment:

- creates dungeon team panels with role buttons, reminders, notifications, and persistent active runs
- stores history in MySQL and uses JSON fallback during outages

Giveaways:

- creates and manages White Walkers giveaways
- supports required roles, ping roles, participant lists, ending, deleting, rerolling, and automatic ending
- admin management uses Leader/Admin/Officer roles; required role setup is Officer-only

Auto roles:

- sends region, guild, and color role panels
- supports preset and custom color roles

Logging:

- logs channel, thread, integration, member exit, nickname, and avatar changes according to the configured logging settings
