// Fits PvP history and mention lists into Discord messages without dropping entries.

function splitMessageParts(parts, separator = '\n', limit = 2000) {
    const messages = [];
    let current = '';
    for (const part of parts) {
        const text = String(part);
        if (!text) continue;
        if (current && current.length + separator.length + text.length > limit) {
            messages.push(current);
            current = '';
        }
        // Names and individual history entries are bounded, but keep the helper safe for longer text.
        let remaining = text;
        while (remaining.length > limit) {
            let end = limit;
            if (/[\uD800-\uDBFF]/u.test(remaining[end - 1])) end--;
            messages.push(remaining.slice(0, end));
            remaining = remaining.slice(end);
        }
        if (remaining) current += (current ? separator : '') + remaining;
    }
    if (current) messages.push(current);
    return messages;
}

module.exports = { splitMessageParts };
