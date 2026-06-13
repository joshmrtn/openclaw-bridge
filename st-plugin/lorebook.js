const fs = require('fs');
const path = require('path');

const AUTO_MEMORY_PREFIX = '[auto-memory]';
const DEFAULT_WORLDS_DIR = path.resolve(process.cwd(), 'data', 'default-user', 'worlds');

function lorebookPath(characterName, worldsDir) {
    const dir = worldsDir || DEFAULT_WORLDS_DIR;
    const safeName = characterName.replace(/[/\\:*?"<>|]/g, '_');
    return path.join(dir, `${safeName}-auto-memory.json`);
}

function readLorebook(characterName, worldsDir) {
    try {
        const raw = fs.readFileSync(lorebookPath(characterName, worldsDir), 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

function nextUid(entries) {
    const uids = Object.keys(entries).map(Number).filter(n => !isNaN(n));
    return uids.length === 0 ? 0 : Math.max(...uids) + 1;
}

// Only find entries created by the memory tool (identified by the openclaw-bridge extension
// marker or the [auto-memory]:: comment prefix). Author-written entries are never touched (R11.3).
function findAutoEntry(entries, entryKey) {
    for (const [uid, entry] of Object.entries(entries)) {
        if (entry?.extensions?.['openclaw-bridge']?.entry_key === entryKey) return { uid, entry };
        if (entry?.comment === `${AUTO_MEMORY_PREFIX}::${entryKey}`) return { uid, entry };
    }
    return null;
}

function buildEntry(uid, entryKey, content, tier, keywords) {
    const isAlwaysActive = tier !== 2;
    const keyArray = (!isAlwaysActive && keywords)
        ? keywords.split(',').map(k => k.trim()).filter(Boolean)
        : [];
    return {
        uid,
        key: keyArray,
        secondary_keys: [],
        comment: `${AUTO_MEMORY_PREFIX}::${entryKey}`,
        content,
        constant: isAlwaysActive,  // true = always injected (Tier 1), false = keyword-triggered (Tier 2)
        vectorized: false,
        selectiveLogic: 0,
        order: 100,
        position: 0,
        disable: false,
        addMemo: true,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: false,
        prob: 100,
        useProbability: false,
        depth: 4,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: false,
        automationId: '',
        role: 0,
        sticky: null,
        cooldown: null,
        delay: null,
        displayIndex: uid,
        extensions: {
            'openclaw-bridge': { entry_key: entryKey, tier: isAlwaysActive ? 1 : 2 },
        },
    };
}

// Write or update a memory entry for a character (R11.1, R11.2).
// Updates existing entries in place; never appends duplicates.
// Only touches entries with the [auto-memory]:: prefix / openclaw-bridge marker (R11.3).
function upsertMemoryEntry(characterName, { entry_key, content, tier = 1, keywords = '' }, worldsDir) {
    if (!entry_key || typeof content !== 'string') {
        throw new Error('entry_key and content are required');
    }

    const resolvedTier = Number(tier) === 2 ? 2 : 1;
    const book = readLorebook(characterName, worldsDir) ?? { entries: {} };
    const existing = findAutoEntry(book.entries, entry_key);

    if (existing) {
        existing.entry.content = content;
        existing.entry.constant = resolvedTier !== 2;
        if (resolvedTier === 2 && keywords) {
            existing.entry.key = keywords.split(',').map(k => k.trim()).filter(Boolean);
        }
        if (existing.entry.extensions?.['openclaw-bridge']) {
            existing.entry.extensions['openclaw-bridge'].tier = resolvedTier;
        }
    } else {
        const uid = nextUid(book.entries);
        book.entries[String(uid)] = buildEntry(uid, entry_key, content, resolvedTier, keywords);
    }

    const filePath = lorebookPath(characterName, worldsDir);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(book, null, 2), 'utf8');

    return { entry_key, tier: resolvedTier, created: !existing };
}

module.exports = {
    upsertMemoryEntry,
    readLorebook,
    lorebookPath,
    AUTO_MEMORY_PREFIX,
    DEFAULT_WORLDS_DIR,
};
