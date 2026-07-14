# WW-Bot

WW-Bot is the White Walkers Discord bot. It handles XP tracking, level rewards, PvP King challenges, dungeon recruitment, giveaways, guild application monitoring, auto-role panels, welcome messages, and server audit logging.

## Requirements

- Node.js 20 or newer
- MySQL or MariaDB for production storage
- A Discord bot token with the required gateway intents enabled
- `Manage Roles`, `Send Messages`, `Embed Links`, `Attach Files`, and command permissions in the target server
- `View Channel`, `Read Message History`, `Send Messages`, and `Send Polls` in the Officer and Court House channels for guild application alerts, polls, and vote reminders

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
- `officerChannelID` and `courtHouseChannelID` for guild application alerts and polls
- `ownerID` for owner-only forum post review alerts
- `forumGuildApplicationPage` for the PRO forum topic monitored for applications
- `forumGuildApplicationCooldownHours`: number of hours the bot ignores additional valid applications from the same forum user after announcing one. Once the cooldown ends, the next valid application is announced. Use `0` to disable this filtering.
- `forumGuildApplicationIgnoredUsers` for forum usernames whose posts should never trigger application handling

## Database Setup

Ready-to-run SQL files are grouped by feature in `sql/`:

- `sql/create_dungeon_tables.sql`
- `sql/create_giveaway_tables.sql`
- `sql/create_guild_settings_table.sql`
- `sql/create_pvp_king_tables.sql`
- `sql/create_xp_level_tables.sql`
- `sql/create_guild_applications_table.sql`

## Runtime Data

Local runtime state is stored in `data/` and ignored by Git.

- `data/dungeon_runs.json`: temporary dungeon fallback state.
- `data/pvp_king_data.json`: temporary PvP King fallback state.
- `data/giveaways.json`: temporary giveaway fallback state.
- `data/guild_settings.json`: mirror of guild settings, kept populated so XP/logging settings still load during a database outage.
- `data/guild_applications.json`: forum scan checkpoint and temporary application records during a MySQL outage. In `json` mode it is the permanent local store.

The fallback files are not meant to be manually edited while the bot is running!

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

Guild applications:

- checks the configured White Walkers PRO forum recruitment topic every five minutes
- silently records the existing topic on first setup, then processes only newly detected posts
- pings the Officer role for valid applications and alerts `ownerID` when a newly observed post is not classified as a valid application
- extracts reordered and loosely formatted application fields, prioritizes the trainer card, posts additional images in batches of ten, and uses local OCR when the IGN is missing from text
- falls back to the stored raw forum post in a `Guild Application` field when too little structured information can be extracted
- creates a 24-hour Yes/No poll in the Court House when the IGN is reliable
- reminds the Officer role after 12 and 18 hours when fewer than half of current Officers have voted
- can ignore repeat applications from the same forum user. Setting `forumGuildApplicationCooldownHours`; `0` announces every valid application
- ignores configured forum usernames, quoted posts, signatures, and copied recruitment-template images
- stores all scanned forum posts and classifications in MySQL, with the same `STORAGE_MODE` JSON fallback behavior as other persistent systems

Before enabling the monitor in production, run `sql/create_guild_applications_table.sql`. Tesseract language data is loaded only when OCR is actually needed; normal labelled applications do not start the OCR worker.

Preview a random strong historical application without posting it:

```powershell
node scripts/test_guild_application_notification.js
```

Post the application preview and its poll in the script's admin test channel (`1184117095231918101`):

```powershell
node scripts/test_guild_application_notification.js --send
```

Other guild-application test modes:

```powershell
# Preview four real application layouts: raw fallback, multiple images, extra information, and missing fields.
node scripts/test_guild_application_notification.js --send-edge-suite

# Post one randomly selected non-application alert for the owner-only review layout.
node scripts/test_guild_application_notification.js --send-non-application-test

# Post an application, poll, non-application alert, and accelerated 1/2-minute reminder previews.
node scripts/test_guild_application_notification.js --send-notification-test-suite

# Preview one known forum post without creating a poll.
node scripts/test_guild_application_notification.js --send-post-test --post-id=1707057
```

Auto roles:

- sends region, guild, and color role panels
- supports preset and custom color roles

Logging:

- logs channel, thread, integration, member exit, nickname, and avatar changes according to the configured logging settings
