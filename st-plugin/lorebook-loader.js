const fs = require('fs');
const path = require('path');

const ST_LORE_DIR = path.join(process.cwd(), 'sillytavern', 'data', 'default-user', 'lorebooks');
const DEFAULT_LORE_DIR = fs.existsSync(ST_LORE_DIR) ? ST_LORE_DIR : path.join(process.cwd(), 'data', 'default-user', 'lorebooks');

async function _listLoreFiles(baseDir) {
    try {
        const files = await fs.promises.readdir(baseDir);
        return files.filter(f => f.toLowerCase().endsWith('.json')).map(f => path.join(baseDir, f));
    } catch (e) {
        return [];
    }
}

async function loadLorebooks(characterName, baseDir = DEFAULT_LORE_DIR) {
    // Look for character-specific directory first, then baseDir files
    const results = [];
    const charDir = path.join(baseDir, characterName);
    const candidates = [];
    if (fs.existsSync(charDir)) candidates.push(...await _listLoreFiles(charDir));
    candidates.push(...await _listLoreFiles(baseDir));

    for (const filePath of candidates) {
        try {
            const txt = await fs.promises.readFile(filePath, 'utf8');
            const parsed = JSON.parse(txt);
            if (Array.isArray(parsed)) {
                for (const entry of parsed) results.push(entry);
            } else if (Array.isArray(parsed.entries)) {
                results.push(...parsed.entries);
            }
        } catch (e) {
            // malformed file — skip but do not throw
            continue;
        }
    }
    return results;
}

function _matchKeyword(text, keyword, opts) {
    if (!keyword) return false;
    const caseInsensitive = opts.caseInsensitive !== false;
    const wholeWord = opts.wholeWord !== false;
    const flags = caseInsensitive ? 'i' : '';
    if (wholeWord) {
        const esc = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\b${esc}\\b`, flags);
        return re.test(text);
    }
    if (caseInsensitive) return text.toLowerCase().includes(keyword.toLowerCase());
    return text.includes(keyword);
}

async function matchLorebookEntries(message, characterName, opts = {}) {
    const entries = await loadLorebooks(characterName, opts.baseDir);
    const matched = [];
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        // support entry.triggers (array) or entry.keyword (string) or fall back to scanning entry.text
        let triggers = [];
        if (Array.isArray(entry.triggers)) triggers = entry.triggers;
        else if (typeof entry.keyword === 'string') triggers = [entry.keyword];
        else if (typeof entry.text === 'string') triggers = [entry.text.slice(0, Math.min(64, entry.text.length))];

        for (const k of triggers) {
            if (_matchKeyword(message, k, opts)) {
                matched.push(Object.assign({ _index: i }, entry));
                break;
            }
        }
    }

    // sort by insertion order (preserve entries order)
    matched.sort((a, b) => a._index - b._index);
    return matched;
}

module.exports = {
    loadLorebooks,
    matchLorebookEntries,
    DEFAULT_LORE_DIR,
};
