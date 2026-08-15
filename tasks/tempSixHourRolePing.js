// ============================================================
// TEMPORARY FEATURE:
// Ping Discord role every 15 minutes before Alto Mare Race starts.
//
// Race times:
// 01:00, 07:00, 13:00, 19:00 UTC/GMT
//
// ============================================================

const CHANNEL_ID = '1301600985655017566';
const ROLE_ID = '1537991574162640906';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const REMINDER_BEFORE_MS = 15 * 60 * 1000;
const RACE_OFFSET_MS = 1 * 60 * 60 * 1000; // Race cycle starts at 01:00 UTC

let timer = null;

function getNextSchedule() {
    const now = Date.now();

    // Find the next 6-hour race boundary, offset to 01:00 UTC.
    let raceStart =
        Math.ceil(
            (now + REMINDER_BEFORE_MS - RACE_OFFSET_MS) / SIX_HOURS_MS
        ) * SIX_HOURS_MS
        + RACE_OFFSET_MS;

    let reminderTime = raceStart - REMINDER_BEFORE_MS;

    // Safety check:
    // If the reminder time somehow already passed, move to the following race.
    if (reminderTime < now) {
        raceStart += SIX_HOURS_MS;
        reminderTime = raceStart - REMINDER_BEFORE_MS;
    }

    return {
        raceStart,
        reminderTime
    };
}


/**
 * Sends the Alto Mare Race reminder.
 *
 * raceStart is the REAL race start time,
 * NOT the reminder time.
 */
async function sendRolePing(client, raceStart) {
    const channel = await client.channels.fetch(CHANNEL_ID);

    if (!channel || !channel.isTextBased()) {
        throw new Error(
            `Channel ${CHANNEL_ID} was not found or is not a text channel.`
        );
    }

    // Discord timestamps use UNIX time in SECONDS.
    const raceStartUnix = Math.floor(raceStart / 1000);

    const MESSAGE =
        `### <@&${ROLE_ID}>, Alto Mare Race starts in 15 minutes!\u2002🔔\n` +
        `- Start time: **<t:${raceStartUnix}:t> (<t:${raceStartUnix}:R>)**\n` +
        `-# - Video Guide: <https://www.youtube.com/watch?v=mYnlLlJ_buI>`;

    await channel.send({
        content: MESSAGE,

        // Only allow this specific role to be pinged.
        allowedMentions: {
            parse: [],
            roles: [ROLE_ID]
        }
    });

    console.log(
        `[TEMP ALTO MARE] Reminder sent at ${new Date().toISOString()} | ` +
        `Race starts at ${new Date(raceStart).toISOString()}`
    );
}


/**
 * Schedule the next reminder.
 *
 * Recalculate the real UTC race/reminder times after every run.
 * Bot restarts will NOT shift the schedule.
 */
function scheduleNextPing(client) {
    const {
        raceStart,
        reminderTime
    } = getNextSchedule();

    const delay = reminderTime - Date.now();

    console.log(
        `[TEMP ALTO MARE] Next reminder: ${new Date(reminderTime).toISOString()} | ` +
        `Race start: ${new Date(raceStart).toISOString()}`
    );

    timer = setTimeout(async () => {
        try {
            await sendRolePing(client, raceStart);

        } catch (err) {
            console.error(
                '[TEMP ALTO MARE] Failed to send reminder:',
                err
            );

        } finally {
            scheduleNextPing(client);
        }
    }, delay);

    timer.unref?.();
}


/**
 * Called once from index.js when Discord client is ready.
 */
function execute(client) {
    // Prevent accidentally starting duplicate timers.
    if (timer) {
        console.warn(
            '[TEMP ALTO MARE] Reminder timer is already running.'
        );
        return;
    }

    console.log(
        '[TEMP ALTO MARE] Starting 15-minute race reminder task.'
    );

    scheduleNextPing(client);
}


module.exports = {
    execute
};
