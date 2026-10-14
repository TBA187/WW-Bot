const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

function readJsonObject(filePath, validate = () => true) {
    let bytes;
    try { bytes = fs.readFileSync(filePath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
        const value = JSON.parse(bytes.toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value) || !validate(value)) {
            throw new Error('Invalid JSON store structure.');
        }
        return value;
    } catch (cause) {
        const preservedPath = `${filePath}.corrupt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        // Copy without replacing the source: recovery must not destroy unsent work.
        fs.copyFileSync(filePath, preservedPath, fs.constants.COPYFILE_EXCL);
        if (!fs.readFileSync(preservedPath).equals(bytes)) throw new Error('Corrupt JSON preservation could not be verified.');
        throw Object.assign(new Error(`JSON recovery paused; original data preserved at ${preservedPath}`, { cause }),
            { code: 'JSON_STORE_CORRUPT', preservedPath });
    }
}

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
    readJsonObject,
    writeJsonIfChanged,
    writeTextIfChanged
};
