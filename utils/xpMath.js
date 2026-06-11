// ==========================
// Utility - XP Mathematics
// ==========================
const xpSettings = require('../config/xpConfig');

module.exports = {
    /**
     * Calculates XP required to go from current level to the NEXT level.
     * Uses the curves configured in xpConfig.js
     * Curves: Linear, Exponential, and Constant (Flat)
     */
    getXpForNextLevel: (level) => {
        // Check if Max Level is set and exceeded
        if (xpSettings.levelFormula.maxLevel && level >= xpSettings.levelFormula.maxLevel) {
            return Infinity;
        }

        const { type, multiplier, baseAmount } = xpSettings.levelFormula;

        // All formulas are multiplied by the 'multiplier' at the end to allow for global difficulty scaling
        let requiredXp = 0;

        switch (type) {
            case 'linear':
                // Formula: (level * 100) + baseAmount
                requiredXp = (level * 100) + baseAmount;
                break;
            case 'exponential':
                // Formula: 5 * (L^2) + (50 * L) + Base (Default 100)
                requiredXp = 5 * Math.pow(level, 2) + (50 * level) + baseAmount;
                break;
            case 'flat':
                // Formula: Require the same base amount 
                requiredXp = baseAmount;
                break;
            default:
                requiredXp = 5 * Math.pow(level, 2) + (50 * level) + 100;
        }

        // Apply the global multiplier (Set to 1 by default for no change)
        return Math.floor(requiredXp * multiplier);
    },

    /**
     * Calculates the TOTAL XP required to reach a specific level starting from 0.
     * Useful for syncing database when an admin sets a level manually.
     */
    getTotalXpForLevel: (level) => {
        let totalXp = 0;
        for (let i = 0; i < level; i++) {
            totalXp += module.exports.getXpForNextLevel(i);
        }
        return totalXp;
    },

    /**
     * Finds what level a user should be based on their total XP.
     * Useful for "re-calculating" a user if their data gets messy.
     */
    getLevelFromTotalXp: (totalXp) => {
        let level = 0;
        let requiredForNext = module.exports.getXpForNextLevel(level);

        while (totalXp >= requiredForNext) {
            // Hard cap to prevent infinite loop if maxLevel is reached
            if (xpSettings.levelFormula.maxLevel && level >= xpSettings.levelFormula.maxLevel) {
                break;
            }

            totalXp -= requiredForNext;
            level++;
            requiredForNext = module.exports.getXpForNextLevel(level);
        }

        return level;
    }
};
