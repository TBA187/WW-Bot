/**
 * @fileoverview Report gateway latency and measured reply latency through /ping.
 * Provides a public connectivity check for White Walker members.
 */
'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { performance } = require('node:perf_hooks');

class Ping {
    constructor() {
        this.name = 'ping';
        this.data = new SlashCommandBuilder()
            .setName('ping')
            .setDescription('Check White Walker bot latency');
    }

    async execute(interaction) {
        const gatewayMs = interaction.client.ws.ping;
        const startTime = performance.now();
        await interaction.reply('Pinging...');
        const apiMs = performance.now() - startTime;

        return interaction.editReply(
            `**<:kyurem:1472065995089645609>  Gateway Latency:** ${gatewayMs.toFixed(2)}ms *(avg)*\n` +
            `**<:kyurem:1472065995089645609>  API Latency:** ${apiMs.toFixed(2)}ms *(real-time)*`
        );
    }
}

module.exports = Ping;
