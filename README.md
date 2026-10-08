# WW-Bot

WW-Bot is the White Walkers Discord bot. It handles PvP scouting, XP tracking, level rewards, PvP King challenges, dungeon recruitment, giveaways, event notifications, guild application and forum shop monitoring, auto-role panels, welcome messages, and server audit logging.

## Requirements

- Node.js 24 LTS recommended (Node.js 22 LTS minimum)
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
npm start
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

Optional database resilience tuning values are:

- `DB_CONNECT_TIMEOUT_MS` (default `10000`)
- `DB_KEEPALIVE_DELAY_MS` (default `30000`)
- `DB_RETRY_COOLDOWN_MS` (default `5000`)
- `DB_RETRY_MAX_COOLDOWN_MS` (default `60000`)
- `DB_STATUS_LOG_INTERVAL_MS` (default `300000`)

`STORAGE_MODE` accepts:

- `auto`: use MySQL when available, fallback to local JSON during outages, then sync back.
- `mysql`: prefer MySQL, fallback to JSON when MySQL is down.
- `json`: only use local JSON files. This is useful for local testing and does not sync to MySQL.

In `auto` or `mysql` mode, transient connection failures open a shared retry circuit so concurrent features do not flood MySQL or the console. The bot logs the first failure, periodic outage status, each affected feature fallback, and recovery. Persistent writes queue in JSON and synchronize when MySQL returns.

Server IDs and feature IDs live in `config.json`, including:

- `botTimezone`: default bot timezone. Current value is `Etc/UTC`.
- `guildId`
- role IDs such as `leaderRoleID`, `adminRoleID`, `officerRoleID`, `pvpKingRoleID`, `dungeonRoleID`, and `proNotificationRoleID`
- channel IDs such as `botChannelID`, `logChannelID`, `pvpKingChannelID`, `dungeonChannelID`, `giveawayChannelID`, and `generalChannelID`
- `officerChannelID` and `courtHouseChannelID` for guild application alerts and polls
- `ownerID` for owner-only forum post review alerts
- `forumGuildApplicationPage` for the PRO forum topic monitored for applications
- `forumGuildApplicationCooldownHours`: number of hours the bot ignores additional valid applications from the same forum user after announcing one. Once the cooldown ends, the next valid application is announced. Use `0` to disable this filtering.
- `tbaProForumShop` and `tbaProDungeonShop` for the two PRO shop topics monitored for new replies
- `tbaProForumNotifications`: use `1` to enable the shop DMs or `0` to disable them
- `pvpScoutingGoldChannelID` and `pvpScoutingSilverChannelID` for the separate Gold and Silver scout channels
- `goldRoleID` and `silverRoleID` for the roles assigned when members select their game server

## Database Setup

Ready-to-run SQL files are grouped by feature in `sql/`:

- `sql/create_dungeon_tables.sql`
- `sql/create_giveaway_tables.sql`
- `sql/create_guild_settings_table.sql`
- `sql/create_notification_tables.sql`
- `sql/create_pvp_king_tables.sql` (both Gold and Silver)
- `sql/create_xp_level_tables.sql`
- `sql/create_guild_applications_table.sql`
- `sql/create_bot_runtime_tables.sql`
- `sql/create_pvp_scout_tables.sql`

## Runtime Data

Local runtime state is stored in `data/` and ignored by Git.

- `data/dungeon_runs.json`: temporary dungeon fallback state.
- `data/pvp_king_data.json`: Gold PvP King fallback state.
- `data/pvp_king_silver_data.json`: Silver PvP King fallback state.
- `data/giveaways.json`: giveaway metadata mirror, plus entries and draw history for active and recently ended giveaways. It preserves pending changes during an outage and syncs them to MySQL when the connection returns.
- `data/xp_pending.json`: persistent queue of XP awards and raw activity counters, plus the last successful special-track settings snapshot. Operations are saved before their first database attempt and replayed automatically after an outage, including after a restart. When moving the bot to another computer or remote host, stop the old instance first. If this file contains pending updates, copy it to the new host before starting the bot there.
- `data/guild_settings.json`: mirror of guild settings, kept populated so XP/logging settings still load during a database outage.
- `data/notifications.json`: notification settings and member subscriptions, used during a MySQL outage and synchronized when MySQL returns.
- `data/guild_applications.json`: forum scan checkpoint and temporary application records during a MySQL outage. In `json` mode it is the permanent local store.
- `data/tba_forum_shops.json`: local recovery mirror for the two TBA shop checkpoints. In `auto` and `mysql` modes, checkpoints are shared through MySQL so switching hosts cannot replay an already processed forum post.
- `data/scout-autocomplete-cache.json`: saved opponent index, grouped report counts and latest report timestamps, ordered by newest scout. The bot loads it into memory at startup and uses that in-memory index throughout the run to return up to 25 suggestions, including typed searches. Autocomplete requests refresh stale entries from MySQL in the background after 60 seconds; report changes invalidate the cache sooner. Successful full-index refreshes update the file when its contents change. Older snapshots still load; missing dates appear after the normal refresh. Its `.tmp` file is used briefly while replacing the saved snapshot.
- `data/scout-autocomplete-silver-cache.json`: the same autocomplete snapshot for Silver. Each archive keeps its own names and counts; neither cache changes saved reports or review decisions.
- `data/tesseract-cache/`: reusable OCR language data downloaded when an OCR worker first needs it.

The fallback files are not meant to be manually edited while the bot is running!

## Feature Overview

Guild settings:

- `/ww-settings` gives guild members a private server-selection panel and a shortcut to the existing `/notifications` menu.
- The shared `guild_members` table stores Discord profiles, current/former membership history and one `selected_server` value (`gold`, `silver`, `cross`, or no selection).
- Authorized settings users who have never held the guild-member role are stored with status `other`, so their settings do not create current/former-member scout warnings.
- Other commands can read the saved preference through `guildMemberStore.getSelectedServer(guildId, discordId)`. Existing commands keep their current behavior until they explicitly use it.
- `pvp_scout_catchup` stores each channel's last successfully processed message ID. Startup scans newer messages, skips archived sources and advances the checkpoint only after a successful catch-up. A missing checkpoint triggers one history scan to establish it.

XP and ranks:

- tracks global XP and special XP tracks
- supports messages, reactions, commands, and voice XP
- assigns level rewards and shows `/rank` and `/leaderboard`
- preserves the original XP amounts, boosts, eligibility, cooldown decisions and activity timestamps during MySQL outages; replay does not reroll or recalculate awards
- uses a transaction and a unique receipt in `xp_applied_operations` to prevent an uncertain save or retry from adding the same XP/activity twice. All four XP tables (`xp_user_levels`, `xp_channel_tracks`, `xp_rewards`, and `xp_applied_operations`) are defined in `sql/create_xp_level_tables.sql`
- retries saved updates with backoff after recovery; committed level-ups retain their original reward/message context for retry, while unsynchronized totals receive a brief note in rank/leaderboard displays
- keeps MySQL as the source for rank/leaderboard totals; those commands explain a database outage instead of showing unverified local totals. Saved special-track settings remain usable after an offline restart; a first installation without a saved snapshot needs MySQL to load special-track rules

PvP King:

- manages crown, challenge, cooldown, history, stats, leaderboard, reverse, and notifier flows
- uses MySQL transactions where multiple PvP database updates must succeed together
- falls back to JSON when MySQL is unavailable
- All eleven PvP King slash commands run only in `pvpKingChannelID` (Gold) or `pvpKingSilverChannelID` (Silver). The invoking channel selects the king role, history thread, stats, challenge cooldowns, and notifications. Buttons remain bound to that server. Configure Silver with `pvpKingSilverChannelID`, `historySilverThreadID`, and `pvpKingSilverRoleID`.

Future PvP King events:

- Configure an event under `pvpKingEvents.gold` or `pvpKingEvents.silver` in `config.json`, then restart. Each server has a separate winner, requirement and reward.
- `/pvp_event` shows the configured event's progress, then its finished results. Without an enabled event, it preserves Vangogsan's finished event, defined in `commands/pvp-king/pvp_event.js`.
- `/pvp_crown` announces the winner in the configured channel. It checks the bot's existing announcement by event ID before posting, including after restarts. Announcement failures are logged without undoing the crown and can be retried on the next crown.

Example event configuration:

```json
"pvpKingEvents": {
  "gold": {
    "enabled": true,
    "id": "gold-winter-2026",
    "name": "Gold Winter PvP King Challenge",
    "startDate": "2026-11-01T00:00:00Z",
    "endDate": null,
    "targetStreak": 10,
    "rewardCoinCapsules": 3,
    "announcementChannelID": "1180559473501290688",
    "mentionEveryone": false
  },
  "silver": null
}
```

Dungeon recruitment:

- creates dungeon team panels with role buttons, reminders, notifications, and persistent active runs
- stores history in MySQL and uses JSON fallback during outages

Giveaways:

- creates and manages White Walkers giveaways
- supports required roles, ping roles, participant lists, ending, deleting, rerolling, and automatic ending
- `/giveaway create` can optionally pin the giveaway message in its channel; the default is No and pinning requires Manage Messages
- schedules the next end time directly, wakes when a giveaway is created or its timing changes, and performs an hourly recovery sweep
- uses a five-minute MySQL end claim to keep two hosts from drawing the same giveaway; the required columns are defined in `sql/create_giveaway_tables.sql`
- retries transient MySQL reads, fixed-ID saves, and exact-token claim release once; claims run once
- waits for MySQL recovery to finish an end draw when a shared claim or its durable save cannot be confirmed
- admin management uses Leader/Admin/Officer roles; required role setup is Officer-only

Guild applications:

- checks the configured White Walkers PRO forum recruitment topic every ten minutes
- silently records the existing topic on first setup, then processes only newly detected posts
- pings the Officer role for valid applications and alerts `ownerID` when a newly observed post is not classified as a valid application
- extracts reordered and loosely formatted application fields, prioritizes the trainer card, posts additional images in batches of ten, and uses local OCR when the IGN is missing from text
- falls back to the stored raw forum post in a `Guild Application` field when too little structured information can be extracted
- creates a 24-hour Yes/No poll in the Court House when the IGN is reliable
- reminds the Officer role after 12 and 18 hours when fewer than half of current Officers have voted
- follows changing forum pagination and relocates its saved post if the forum page size changes; empty or partially unreadable pages leave the checkpoint unchanged
- bounds HTTP requests through the complete HTML/image-body download so a stalled response cannot block later scans
- can ignore repeat applications from the same forum user. Setting `forumGuildApplicationCooldownHours`; `0` announces every valid application
- ignores forum authors who match a current member with `leaderRoleID`, `adminRoleID`, or `officerRoleID`; compares the server nickname, then global display name if no nickname exists, then username if neither exists. Matching is case-insensitive and accepts delimited IGN aliases such as `Vangogsan / Am1damaru`. Other members are not suppressed
- excludes quoted posts, signatures, and copied recruitment-template images from application parsing
- stores all scanned forum posts and classifications in MySQL; continues scanning from its local checkpoint during a MySQL outage, queues records in JSON, and merges delivery state when MySQL returns. Pending alerts are rechecked against current staff before retrying

Before enabling the monitor in production, run `sql/create_guild_applications_table.sql`. Tesseract language data is loaded only when OCR is actually needed; normal labelled applications do not start the OCR worker.

PvP scouting:

- `/scout in_game_name:<name>` opens an opponent's scout history with teams, PvP ratings, contributors, screenshots, notes, and links to the original reports.
- Scout reports are automatically parsed from the configured Gold and Silver scouting channels. A new report that cannot be validated receives 👎 and correction suggestions. It stays out of `/scout-review` and the officer channel for **one hour after its first 👎**. Failed edits keep the original deadline; a successful correction cancels it. Unresolved reports enter the officer review queue and trigger one officer alert after the deadline.
- Correction deadlines are saved in `pvp_scout_correction_windows` and resumed after restarts. The bot rechecks the Discord message before escalation, including edits made while it was offline.
- Same-author follow-up messages and screenshots can be grouped into the same report. Edits to unresolved scouts automatically retry validation.
- `/scout-review` allows Leaders, Admins, and Officers to review, correct, approve, reject, or export reports that require manual review.
- `/scout-settings` allows staff to search and manage published scout reports, sources, friendly players, and current/former guild members.
- `/scout-stats` shows combined Gold/Silver report, opponent, rating, screenshot and contributor totals. Teams and contributors are counted per grouped report, including valid follow-ups. New lookups refresh after report changes; contributor navigation reuses the opened snapshot.
- Gold and Silver scout histories are stored separately. **Cross Server** searches both archives without merging their underlying reports.
- Users can save a preferred server with `/ww-settings`. A server can also be selected temporarily when using `/scout` without changing the saved preference.
- Scout pages support Pokémon searches, detailed report views, sorting, autocomplete, screenshots, average/latest PvP ratings, and server switching.
- Server dropdown counts use brief cached count queries instead of loading the other archive's complete reports. Saved report changes clear these counts immediately.
- Matching current/former guild members and players on the Friendly List display a recommendation to arrange a draw using the in-game `/draw` command.
- New messages, replies, edits, and deletions are tracked while the bot is online. Missed scout messages are recovered automatically after startup.
- Staff corrections, review decisions, and administrative changes are stored in MySQL and preserved across archive refreshes.

The bundled Pokémon species data is derived from [Pokémon Showdown's Pokédex data](https://github.com/smogon/pokemon-showdown/blob/a5df8274e85b0889bf2a9b3422a08b39732374fc/data/pokedex.ts). Its license notice is included in `features/pvp-scouting/POKEMON_SHOWDOWN_LICENSE.txt`.

TBA forum shop notifications:

- checks each configured shop topic every twelve minutes; the Forum Shop starts after three minutes and the Dungeon Shop after seven minutes so all three forum monitors are staggered
- silently records each topic's latest post on first startup, so historical replies do not generate DMs
- sends `ownerID` a DM containing the author, complete message content, timestamp, direct forum-post link, and every image from each new reply
- places the first image in the embed and sends additional images immediately afterward in batches of ten
- catches up on every reply posted while the bot was offline, including new pages and forum page-size changes
- shares its latest processed post through MySQL and checks recent owner DMs by forum-post URL before sending, preventing replay when switching machines
- uses exponential backoff for forum outages and rate limits, and retries failures without advancing the saved post checkpoint
- adds a warning and keeps the original forum link when some post details or images cannot be fetched
- ignores replies posted by the forum username `tba7`, using a case-insensitive comparison
- continues scanning from its local page/post checkpoint in `data/tba_forum_shops.json` during MySQL outages and synchronizes the newer progress when MySQL returns. Unchanged polls read the shared checkpoint without rewriting it
- retains an unreadable checkpoint file and reports the error instead of replacing it with an empty baseline

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
