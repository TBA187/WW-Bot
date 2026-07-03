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

    fs.writeFileSync(tempFilePath, text);
    fs.renameSync(tempFilePath, filePath);
    return true;
}

function writeJsonIfChanged(filePath, tempFilePath, data) {
    return writeTextIfChanged(filePath, tempFilePath, JSON.stringify(data, null, 2));
}

module.exports = {
    writeJsonIfChanged,
    writeTextIfChanged
};
