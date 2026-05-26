const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// Prefer the SillyTavern bundled data directory when present, otherwise fall back
const ST_CHAR_DIR = path.join(process.cwd(), 'sillytavern', 'data', 'default-user', 'characters');
const DEFAULT_CHAR_DIR = fs.existsSync(ST_CHAR_DIR) ? ST_CHAR_DIR : path.join(process.cwd(), 'data', 'default-user', 'characters');

async function _tryUseDiskCache(filePath) {
    // Accessing SillyTavern's full endpoints module triggers global initialization
    // (config, globals) that may not be available in this plugin context. To avoid
    // side effects and initialization errors, skip trying to read ST's disk cache
    // here. The loader will fall back to the official parser instead.
    return null;
}

async function _parseWithOfficialParser(filePath) {
    // dynamic import of ST's official parser
    const possible = [
        path.join(process.cwd(), 'sillytavern', 'src', 'character-card-parser.js'),
        path.join(process.cwd(), 'src', 'character-card-parser.js'),
    ];
    let parser = null;
    for (const p of possible) {
        if (fs.existsSync(p)) { parser = await import(pathToFileURL(p).toString()); break; }
    }
    if (!parser) throw new Error('SillyTavern character-card-parser not found');
    if (!parser || typeof parser.parse !== 'function') throw new Error('Parser API missing');
    const result = await parser.parse(filePath, 'png');
    return result;
}

async function loadCharacterRawJson(fileName, charDir = DEFAULT_CHAR_DIR) {
    const filePath = path.join(charDir, fileName);
    if (!fs.existsSync(filePath)) throw new Error('Character file not found');

    // 1) Try disk cache from ST endpoints
    const cached = await _tryUseDiskCache(filePath);
    if (cached) return cached;

    // 2) Fallback to official parser
    const parsed = await _parseWithOfficialParser(filePath);
    return parsed;
}

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

    for (const f of files) {
        const name = f.replace(/\.png$/i, '');
        try {
            const low = f.toLowerCase();
            if (low.endsWith('.json')) {
                const filePath = path.join(charDir, f);
                const txt = fs.readFileSync(filePath, 'utf8');
                const meta = JSON.parse(txt);
                out.push({ name, meta });
                continue;
            }

            const jsonText = await loadCharacterRawJson(f, charDir);
            let meta = null;
            try { meta = JSON.parse(jsonText); } catch (e) { meta = jsonText; }
            out.push({ name, meta });
        } catch (err) {
            out.push({ name, error: err.message });
        }
    }
    return out;
}

module.exports = {
    loadCharacterRawJson,
    listCharacters,
};
