const fs = require('fs');
const path = require('path');

// Prefer the SillyTavern bundled data directory when present, otherwise fall back.
const ST_CHAR_DIR = path.join(process.cwd(), 'sillytavern', 'data', 'default-user', 'characters');
const DEFAULT_CHAR_DIR = fs.existsSync(ST_CHAR_DIR) ? ST_CHAR_DIR : path.join(process.cwd(), 'data', 'default-user', 'characters');

async function listCharacters(charDir = DEFAULT_CHAR_DIR) {
    const out = [];
    let files = [];
    try {
        files = fs.readdirSync(charDir).filter(f => {
            const low = f.toLowerCase();
            return low.endsWith('.png') || low.endsWith('.json');
        });
    } catch (err) {
        return out;
    }

    files.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    for (let chid = 0; chid < files.length; chid += 1) {
        const fileName = files[chid];
        let name = fileName.replace(/\.(png|json)$/i, '');
        const entry = { name, chid, fileName };

        try {
            const filePath = path.join(charDir, fileName);
            if (fileName.toLowerCase().endsWith('.json')) {
                const txt = fs.readFileSync(filePath, 'utf8');
                entry.meta = JSON.parse(txt);
                if (entry.meta && typeof entry.meta.name === 'string' && entry.meta.name.trim()) {
                    name = entry.meta.name.trim();
                    entry.name = name;
                }
            }
        } catch (err) {
            entry.error = err.message;
        }

        out.push(entry);
    }
    return out;
}

module.exports = {
    listCharacters,
};
