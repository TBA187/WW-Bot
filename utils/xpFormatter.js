// ==========================
// Utility - XP Formatter
// ==========================

module.exports = {
    /**
     * Formats a number with commas (e.g., 1000 -> 1,000)
     * @param {number} number 
     * @returns {string}
     */
    formatNumber: (number) => {
        return new Intl.NumberFormat('en-US').format(number);
    },

    /**
     * Shortens large numbers (e.g., 10500 -> 10.5k)
     */
    shortenNumber: (number) => {
        return new Intl.NumberFormat('en-US', {
            notation: "compact",
            maximumFractionDigits: 1
        }).format(number);
    }
};
