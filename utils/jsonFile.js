const fs = require('fs');
const path = require('path');

function writeTextIfChanged(filePath, tempFilePath, text) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    try {
        if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === text) {
            return false;
        }
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }

    try {
        fs.writeFileSync(tempFilePath, text);
        fs.renameSync(tempFilePath, filePath);
    } catch (error) {
        // A full disk can leave a partial .tmp file. Keep the last complete
        // snapshot intact and remove the partial file before the next retry.
        try {
            fs.unlinkSync(tempFilePath);
        } catch {
            // The original write failure is the actionable error.
        }
        throw error;
    }
    return true;
}

function writeJsonIfChanged(filePath, tempFilePath, data) {
    return writeTextIfChanged(filePath, tempFilePath, JSON.stringify(data, null, 2));
}

module.exports = {
    writeJsonIfChanged,
    writeTextIfChanged
};
