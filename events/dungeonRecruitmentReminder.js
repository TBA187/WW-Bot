// ----------------------------------------------------
// Dungeon recruitment reminder hook
// ----------------------------------------------------
module.exports = {
    name: 'messageCreate',
    async execute(message, config) {
        if (message.author.bot) return;

        const handledCommands = new Set();
        for (const command of config.commandMap.values()) {
            if (handledCommands.has(command)) continue;
            handledCommands.add(command);

            if (typeof command.handleMessageCreate === 'function') {
                await command.handleMessageCreate(message);
            }
        }
    }
};
