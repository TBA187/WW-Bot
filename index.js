// Load environment settings before constructing and starting the bot.
require('dotenv').config({ quiet: true });
const appConfig = require('./config.json');
process.env.TZ = appConfig.botTimezone || 'Etc/UTC';
const runtimeLogging = require('./utils/runtimeLogging.js').installRuntimeLogging();
const { createBotApplication } = require('./app/createBotApplication.js');

const application = createBotApplication({ appConfig, runtimeLogging });
if (application) void application.start();
