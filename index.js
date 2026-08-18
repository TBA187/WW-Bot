require('dotenv').config();
const appConfig = require('./config.json');
process.env.TZ = appConfig.botTimezone || 'Etc/UTC';
const db = require('./db/db-conn.js');
const PvpKingStorage = require('./commands/pvp-king/utils/pvpKingStorage.js');
const { createGiveawayStore, startGiveawayLoop } = require('./events/giveaways.js');
const NotificationStore = require('./features/pro-notifications/NotificationStore.js');
const { NOTIFICATION_DEFINITIONS } = require('./features/pro-notifications/notificationCatalog.js');
const {
    createGuildApplicationMonitor,
    handleGuildForumFeedbackButton
} = require('./features/guild-applications/index.js');
const { createTbaForumShopMonitor } = require('./features/tba-forum-shops/index.js');
const { writeJsonIfChanged } = require('./utils/jsonFile.js');
const {
    Client,
    GatewayIntentBits,
    Partials,
    Routes,
    REST,
    Events,
    ActivityType,
    MessageFlags
} = require('discord.js');
const {
    botTimezone, guildId, welcomeChannelID, ownerID, leaderRoleID, adminRoleID, officerRoleID, pvpKingRoleID, pvpWarriorRoleID, wwRoleID, streamRoleID, botChannelID, logChannelID, ignoredLogChannels, ignoreLogPrivateChannelCreate, blockedEditBotMsgChannels, pvpKingChannelID, historyThreadID, dungeonChannelID, dungeonRoleID, giveawayChannelID
} = appConfig;

const fs = require("fs");
const path = require("path");

const GUILD_SETTINGS_FILE = path.join(__dirname, 'data', 'guild_settings.json');
const GUILD_SETTINGS_TEMP_FILE = `${GUILD_SETTINGS_FILE}.tmp`;
const GUILD_SETTINGS_SYNC_INTERVAL_MS = 5 * 60 * 1000;

const token = process.env.TOKEN;
const clientId = process.env.CLIENT_ID;
if (!token || !clientId) {
    console.error("TOKEN or CLIENT_ID is undefined. Bot cannot start!");
    process.exit(1);
}

// Initialize Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildWebhooks,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.GuildMember, Partials.User, Partials.Message, Partials.Reaction]
});

// Map with DB Guild Settings where Key = guild_id, Value = { xp_enabled: false, ... }
const guildSettingsCache = new Map();

function guildSettingsStorageMode() {
    const mode = String(process.env.STORAGE_MODE || 'auto').toLowerCase();
    return ['auto', 'mysql', 'json'].includes(mode) ? mode : 'auto';
}

function canUseGuildSettingsMysql() {
    return guildSettingsStorageMode() !== 'json' && db.hasRequiredConfig;
}

function normalizeGuildSettingsDate(value) {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    return String(value);
}

function defaultGuildSettingsRows() {
    if (!guildId) return [];
    return [{
        guild_id: String(guildId),
        guild_name: 'White Walkers',
        xp_enabled: 1,
        xp_date_enabled: '2026-05-11 04:56:00',
        logging_enabled: 1,
        updated_at: '2026-06-05 02:12:20'
    }];
}

function normalizeGuildSettingsRow(row) {
    return {
        guild_id: String(row.guild_id),
        guild_name: row.guild_name ?? null,
        xp_enabled: Number(row.xp_enabled || 0),
        xp_date_enabled: normalizeGuildSettingsDate(row.xp_date_enabled),
        logging_enabled: Number(row.logging_enabled || 0),
        updated_at: normalizeGuildSettingsDate(row.updated_at)
    };
}

function guildSettingsMirrorData(rows = defaultGuildSettingsRows(), pendingSync = false) {
    return {
        version: 1,
        source: 'mysql_mirror',
        pendingSync,
        settings: rows.map(normalizeGuildSettingsRow)
    };
}

function writeGuildSettingsMirror(rows, pendingSync = false) {
    return writeJsonIfChanged(GUILD_SETTINGS_FILE, GUILD_SETTINGS_TEMP_FILE, guildSettingsMirrorData(rows, pendingSync));
}

function readGuildSettingsMirror() {
    fs.mkdirSync(path.dirname(GUILD_SETTINGS_FILE), { recursive: true });

    if (!fs.existsSync(GUILD_SETTINGS_FILE)) {
        const data = guildSettingsMirrorData();
        writeGuildSettingsMirror(data.settings, false);
        return data;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(GUILD_SETTINGS_FILE, 'utf8'));
        const settings = Array.isArray(parsed.settings) && parsed.settings.length > 0
            ? parsed.settings.map(normalizeGuildSettingsRow)
            : defaultGuildSettingsRows();

        return {
            version: 1,
            source: 'mysql_mirror',
            pendingSync: parsed.pendingSync === true,
            settings
        };
    } catch (err) {
        console.error('[WW LOG] Failed to read guild settings JSON mirror:', err);
        const data = guildSettingsMirrorData();
        writeGuildSettingsMirror(data.settings, false);
        return data;
    }
}

function cacheGuildSettingsRows(rows) {
    guildSettingsCache.clear();

    rows.forEach(row => {
        if (row.guild_id) {
            // Ensure ID is always a string for Map consistency
            guildSettingsCache.set(String(row.guild_id), {
                xpEnabled: Number(row.xp_enabled) === 1,
                xpDateEnabled: row.xp_date_enabled,
                loggingEnabled: Number(row.logging_enabled) === 1
            });
        }
    });
}

async function upsertGuildSettingsRows(rows) {
    for (const row of rows.map(normalizeGuildSettingsRow)) {
        await db.query(`
            INSERT INTO guild_settings (guild_id, guild_name, xp_enabled, xp_date_enabled, logging_enabled)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                guild_name = VALUES(guild_name),
                xp_enabled = VALUES(xp_enabled),
                xp_date_enabled = VALUES(xp_date_enabled),
                logging_enabled = VALUES(logging_enabled)
        `, [
            row.guild_id,
            row.guild_name,
            row.xp_enabled,
            row.xp_date_enabled,
            row.logging_enabled
        ]);
    }
}

async function syncPendingGuildSettingsMirror() {
    const mirror = readGuildSettingsMirror();
    if (!mirror.pendingSync || !canUseGuildSettingsMysql()) return false;

    await upsertGuildSettingsRows(mirror.settings);
    writeGuildSettingsMirror(mirror.settings, false);
    console.log(`[WW LOG] Synced ${mirror.settings.length} pending guild setting(s) to MySQL.`);
    return true;
}

function loadGuildSettingsFromMirror() {
    const mirror = readGuildSettingsMirror();
    cacheGuildSettingsRows(mirror.settings);
    console.warn(`[WW LOG] Loaded ${guildSettingsCache.size} guild setting(s) from JSON mirror.`);
    return mirror;
}

function saveGuildSettingToMirror(row, { pendingSync = false } = {}) {
    const mirror = readGuildSettingsMirror();
    const byGuildId = new Map(mirror.settings.map(setting => [String(setting.guild_id), setting]));
    const normalized = normalizeGuildSettingsRow(row);
    byGuildId.set(String(normalized.guild_id), normalized);
    const settings = [...byGuildId.values()];

    writeGuildSettingsMirror(settings, mirror.pendingSync || pendingSync);
    cacheGuildSettingsRows(settings);
}

/**
 * Fetch database settings for all guilds and store them in memory.
 */
// TO-DO: ADD API CALL: When a setting is changed from the website dashboard, run syncDBSettings()
async function syncDBSettings({ quiet = false } = {}) {
    if (!canUseGuildSettingsMysql()) {
        loadGuildSettingsFromMirror();
        return false;
    }

    try {
        const syncedPending = await syncPendingGuildSettingsMirror();

        await db.query(`
            UPDATE guild_settings
            SET xp_date_enabled = CURRENT_TIMESTAMP
            WHERE xp_enabled = 1
              AND xp_date_enabled IS NULL
        `);

        // Get the newest guild settings from the Database
        const [rows] = await db.query('SELECT guild_id, guild_name, xp_enabled, xp_date_enabled, logging_enabled, updated_at FROM guild_settings');
        const settings = rows.map(normalizeGuildSettingsRow);

        if (!settings.length) {
            console.log('[WW LOG] ⚠️ No rows found in guild_settings table.');
            loadGuildSettingsFromMirror();
            return false;
        }

        cacheGuildSettingsRows(settings);
        const mirrorChanged = writeGuildSettingsMirror(settings, false);
        if (!quiet || syncedPending || mirrorChanged) {
            console.log(`[WW LOG] ✅ Cached settings for ${guildSettingsCache.size} guilds.`);
        }
        return true;
    } catch (err) {
        console.error('[WW LOG] ❌ Failed to sync settings:', err);
        loadGuildSettingsFromMirror();
        return false;
    }
}

function startGuildSettingsSyncLoop() {
    if (client.guildSettingsSyncLoop) return;

    client.guildSettingsSyncLoop = setInterval(() => {
        syncDBSettings({ quiet: true }).catch(err => console.error('[WW LOG] Guild settings sync loop failed:', err));
    }, GUILD_SETTINGS_SYNC_INTERVAL_MS);
    client.guildSettingsSyncLoop.unref?.();
}

// Cooldowns to prevent Discord Rate Limits
const cooldowns = new Map();
const onCooldown = (userId, command, seconds) => {
    const key = `${userId}:${command}`;
    const now = Date.now();
    const expires = cooldowns.get(key) ?? 0;
    if (now < expires) return true;
    cooldowns.set(key, now + seconds * 1000);
    return false;
};

const commandMap = new Map();

// ------- PvP King configs -------
// let currentKingId = null; // PvP Current King cache
// let activeChallenge = null; // Global PvP Challenge Lock
const challengeTimeouts = new Map(); // PvP challenge confirmation timers
const pvpKingStorage = new PvpKingStorage({ db });
const giveawayStore = createGiveawayStore({ db });
const notificationStore = new NotificationStore({
    db,
    guildId,
    definitions: NOTIFICATION_DEFINITIONS
});
const guildApplicationMonitor = createGuildApplicationMonitor({ client, db, config: appConfig });
const tbaForumShopMonitor = createTbaForumShopMonitor({ client, config: appConfig });

// Build config object (Parameters to send to command classes)
const commandConfig = {
    client,
    db,
    botTimezone,
    guildId,
    welcomeChannelID,
    ownerID,
    leaderRoleID,
    adminRoleID,
    officerRoleID,
    pvpKingRoleID,
    pvpWarriorRoleID,
    wwRoleID,
    botChannelID,
    logChannelID,
    ignoredLogChannels,
    ignoreLogPrivateChannelCreate,
    blockedEditBotMsgChannels,
    pvpKingChannelID,
    historyThreadID,
    dungeonChannelID,
    dungeonRoleID,
    giveawayChannelID,
    giveawayStore,
    notificationStore,
    challengeTimeouts,
    pvpKingStorage,
    onCooldown,
    commandMap,
    guildSettingsCache
};

async function bootstrap() {
    try {
        // Wait for DB Connection
        console.log('[WW LOG] Establishing database connection...');
        const dbReady = await db.initPromise;

        // INITIAL SETTINGS LOAD: Load settings before events start firing.
        if (!dbReady) {
            console.warn('[WW LOG] Database unavailable at startup. DB-backed features will retry when used.');
        }
        await syncDBSettings();

        await pvpKingStorage.restore();
        await giveawayStore.restore();
        await notificationStore.restore();

        // Load commands
        const commandsForDiscord = []; // JSON for the REST API
        const commandsPath = path.join(__dirname, "commands");
        const items = fs.readdirSync(commandsPath, { withFileTypes: true }); // Check if item is a folder or a file

        for (const item of items) {
            let commandFiles = [];
            let basePath = "";

            if (item.isDirectory()) {
                // It's a subfolder (e.g., /commands/levels)
                basePath = `./commands/${item.name}/`;
                const folderPath = path.join(commandsPath, item.name);
                commandFiles = fs.readdirSync(folderPath).filter(file => file.endsWith(".js"));
            } else if (item.name.endsWith(".js")) {
                // It's a loose file directly inside /commands
                basePath = `./commands/`;
                commandFiles = [item.name];
            }

            for (const file of commandFiles) {
                const CommandClass = require(`${basePath}${file}`);
                const command = new CommandClass(commandConfig);
                commandMap.set(command.name, command);

                const commandData = Array.isArray(command.data) ? command.data : [command.data];
                for (const cmd of commandData) {
                    commandsForDiscord.push(cmd.toJSON());
                    if (cmd.name) commandMap.set(cmd.name, command);
                }
            }
        }
        console.log(`[WW LOG] Loaded ${commandMap.size} commands:`);
        console.log(' - ' + [...commandMap.keys()].join(", "));

        // Register commands dynamically
        const rest = new REST({ version: '10' }).setToken(token);
        try {
            console.log('[WW LOG] Registering Guild slash commands...');
            await rest.put(
                Routes.applicationGuildCommands(clientId, guildId),
                { body: commandsForDiscord }
            );
            console.log('[WW LOG] ✅ Global slash commands registered to Discord');
        } catch (err) {
            console.error('[WW LOG] ❌ ERROR: Command registration failed:', err);
            throw err;
        }

        // Load events dynamically
        const eventsPath = path.join(__dirname, 'events');
        const eventItems = fs.readdirSync(eventsPath, { withFileTypes: true });

        for (const item of eventItems) {
            let eventFiles = [];
            let basePath = "";

            // Check if it's a folder or a file
            if (item.isDirectory()) {
                basePath = `./events/${item.name}/`;
                const folderPath = path.join(eventsPath, item.name);
                eventFiles = fs.readdirSync(folderPath).filter(file => file.endsWith(".js"));
            } else if (item.name.endsWith(".js")) {
                basePath = `./events/`;
                eventFiles = [item.name];
            }

            for (const file of eventFiles) {
                const event = require(`${basePath}${file}`);

                if (file === 'memberExit.js') {
                    client.on('guildMemberRemove', member => event.handleMemberRemove(member, logChannelID));
                    client.on('guildBanAdd', ban => event.handleGuildBanAdd(ban, logChannelID));
                    client.on('guildBanRemove', ban => event.handleGuildBanRemove(ban, logChannelID));
                    client.on('guildMemberUpdate', (oldM, newM) => event.handleGuildMemberUpdate(oldM, newM, logChannelID));
                    continue;
                }

                if (file === 'channelLogs.js') {
                    client.on('channelCreate', channel => event.handleChannelCreate(channel, commandConfig));
                    client.on('channelDelete', channel => event.handleChannelDelete(channel, commandConfig));
                    client.on('channelUpdate', (oldC, newC) => event.handleChannelUpdate(oldC, newC, commandConfig));
                    continue;
                }

                if (file === 'integrationLogs.js') {
                    client.on('webhooksUpdate', channel => event.handleWebhookUpdate(channel, commandConfig));
                    continue;
                }

                if (file === 'threadLogs.js') {
                    client.on('threadCreate', thread => event.handleThreadCreate(thread, commandConfig));
                    client.on('threadDelete', thread => event.handleThreadDelete(thread, commandConfig));
                    client.on('threadUpdate', (oldT, newT) => event.handleThreadUpdate(oldT, newT, commandConfig));
                    continue;
                }

                if (file === 'userUpdatesLogger.js') {
                    client.on('userUpdate', (oldU, newU) => event.handleUserUpdate(oldU, newU, commandConfig));
                    client.on('guildMemberUpdate', (oldM, newM) => event.handleGuildMemberUpdate(oldM, newM, commandConfig));
                    continue;
                }

                // Standard Event Handling
                if (event.name && typeof event.execute === 'function') {
                    // MASTER SETTINGS LOGIC - Skip listening for events if disabled globally
                    const isXPFile = file.toLowerCase().startsWith('xp'); // Checks if filename starts with 'xp'
                    // Add check for logging_enabled, etc.

                    const executeEvent = (...args) => {
                        if (isXPFile) {
                            const eventData = args[0];
                            // const gId = eventData?.guild?.id || eventData?.guildId;
                            // Correctly extract Guild ID regardless of event type
                            const gId = eventData?.guild?.id ||     // For Message
                                eventData?.message?.guild?.id ||    // For Reaction
                                eventData?.guildId;                 // For VoiceState/Interaction

                            // Prevent errors/db clutter if the event happens in a DM
                            if (!gId) return;

                            // Default to FALSE if not found in cache
                            const settings = guildSettingsCache.get(String(gId)) || { xpEnabled: false };

                            // Exit immediately if XP is disabled for this guild
                            if (!settings.xpEnabled) return;
                        }

                        event.execute(...args, commandConfig);
                    };

                    if (event.once) {
                        client.once(event.name, executeEvent);
                    } else {
                        client.on(event.name, executeEvent);
                    }
                    console.log(`[WW LOG] Registered Event: ${event.name} (${basePath}${file})`);
                }
            }
        }

        await client.login(token);

    } catch (err) {
        console.error('[WW LOG] 🚨 Startup Failed:', err);
        process.exit(1);
    }
}

// Global Safety Listeners (prevents crashes)
client.on('error', err => console.error('Discord client error:', err));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

// Client Ready
client.once(Events.ClientReady, async () => {
    console.log(`[WW LOG] Logged in as ${client.user.tag}`);

    // TO-DO: ADD "Lazy Load" - Instead of checking all guilds at startup, check for the guild
    // only when an event happens. If the settings aren't in the cache, fetch/create them then.
    // // [DB BACKFILL FOR EXISTING GUILDS]
    // console.log('[WW LOG] Ensuring all current guilds exist in database...');
    // const allGuilds = client.guilds.cache;
    // for (const [id, guild] of allGuilds) {
    //     try {
    //         await db.query(
    //             'INSERT IGNORE INTO guild_settings (guild_id, guild_name, xp_enabled, logging_enabled) VALUES (?, ?, 0, 0)',
    //             [id, guild.name]
    //         );
    //     } catch (dbErr) {
    //         console.error(`[WW LOG] Error backfilling guild ${guild.name}:`, dbErr);
    //     }
    // }
    // await syncDBSettings(); // Refresh the cache after backfilling

    // Presence settings: Set Bot Status and Activity
    const status = process.env.BOT_STATUS || 'online';
    const type = process.env.ACTIVITY_TYPE || 'Watching';
    const name = process.env.ACTIVITY_NAME || 'White Walkers';

    client.user.setPresence({
        status: status,
        activities: [{
            name: name,
            type: ActivityType[type] || ActivityType.Playing,
        }],
    });

    // Check if PvP King cooldowns naturally expired (every 60 seconds)
    pvpKingStorage.startSyncLoop();
    notificationStore.startSyncLoop();
    startGuildSettingsSyncLoop();
    // Check active Giveaways to end them on time
    startGiveawayLoop(client, commandConfig);
    // The first forum scan builds a silent baseline; later scans only report newly submitted applications.
    guildApplicationMonitor.start().catch(err => console.error('[WW LOG] Guild Application monitor failed to start:', err));
    // The two shop checks are staggered after the application monitor to avoid a burst of forum requests.
    tbaForumShopMonitor.start().catch(err => console.error('[WW LOG] TBA PRO Forum shop monitor failed to start:', err));
    require('./events/userUpdatesLogger.js').primeUserProfileCache(commandConfig);
    const cooldownTask = require('./tasks/cooldownNotifier.js');
    cooldownTask.execute(client, commandConfig);

    // ============================================================
    // PRO NOTIFICATION PINGS
    // ============================================================
    const proNotifications = require('./tasks/proNotifications.js');
    proNotifications.execute(client, appConfig, notificationStore);
});

// Auto-Config DB settings for New Servers the bot just joined
client.on('guildCreate', async (guild) => {
    console.log(`[WW LOG] New Guild joined: ${guild.name} (${guild.id})`);
    const defaultSetting = {
        guild_id: guild.id,
        guild_name: guild.name,
        xp_enabled: 0,
        xp_date_enabled: null,
        logging_enabled: 0,
        updated_at: new Date().toISOString()
    };

    try {
        if (canUseGuildSettingsMysql()) {
            // Insert with defaults (0/False)
            await upsertGuildSettingsRows([defaultSetting]);
            saveGuildSettingToMirror(defaultSetting);
        } else {
            saveGuildSettingToMirror(defaultSetting, { pendingSync: true });
        }
    } catch (err) {
        console.error('[WW LOG] Error setting up new guild:', err);
        saveGuildSettingToMirror(defaultSetting, { pendingSync: true });
    }
});

// Discord Interactions
client.on('interactionCreate', async interaction => {
    try {
        // Autocomplete Handling
        if (interaction.isAutocomplete()) {
            const command = commandMap.get(interaction.commandName);
            if (command && typeof command.handleAutocomplete === 'function') {
                return await command.handleAutocomplete(interaction);
            }
            return;
        }

        // Button Handling
        if (interaction.isButton()) {
            if (await handleGuildForumFeedbackButton(interaction, { ownerID: appConfig.ownerID })) return true;

            for (const command of new Set(commandMap.values())) {
                if (typeof command.handleButton === 'function') {
                    const handled = await command.handleButton(interaction);
                    if (handled) return true; // explicitly mark handled
                }
            }
        }

        // Select Menu Handling
        if (interaction.isStringSelectMenu()) {
            for (const command of new Set(commandMap.values())) {
                if (typeof command.handleSelect === 'function') {
                    const handled = await command.handleSelect(interaction);
                    if (handled) return true;
                }
            }
        }

        // Modal Handling
        if (interaction.isModalSubmit()) {
            for (const command of new Set(commandMap.values())) {
                if (typeof command.handleModal === 'function') {
                    const handled = await command.handleModal(interaction);
                    if (handled) return true;
                }
            }
        }

        // Context Menu Handling (Right-click message)
        if (interaction.isMessageContextMenuCommand()) {
            // Check both properties: standard slash commands and context menu
            let command = [...commandMap.values()].find(cmd => cmd.data?.some?.(d => d.name === interaction.commandName));
            if (!command) command = commandMap.get(interaction.commandName);

            if (command) return await command.execute(interaction);
            return;
        }

        // Slash Command Handling
        if (interaction.isChatInputCommand()) {
            const command = commandMap.get(interaction.commandName);
            if (command) {
                return await command.execute(interaction);
            }
            return;
        }
    } catch (err) {
        console.error('Interaction error:', err);
        // Autocomplete interactions don't have reply/editReply methods
        if (interaction.isAutocomplete()) {
            return;
        }
        if (interaction.deferred || interaction.replied) {
            interaction.editReply({ content: '⚠️ Something went wrong!' }).catch(() => { });
        } else {
            interaction.reply({ content: '⚠️ Something went wrong!', flags: MessageFlags.Ephemeral }).catch(() => { });
        }
    }
});

bootstrap();
