const fs = require('fs');
const path = require('path');

// Prefer SillyTavern's data path when present, otherwise repo-local data
const ST_CHATS_DIR = path.join(process.cwd(), 'sillytavern', 'data', 'default-user', 'chats');
const DEFAULT_CHATS_DIR = fs.existsSync(ST_CHATS_DIR) ? ST_CHATS_DIR : path.join(process.cwd(), 'data', 'default-user', 'chats');

// Simple in-process per-file queue to serialize writes and avoid races
const _queues = new Map();
function _enqueue(fileKey, fn) {
    const prev = _queues.get(fileKey) || Promise.resolve();
    const next = prev.then(() => fn());
    // swallow errors in queue holder so subsequent ops continue
    _queues.set(fileKey, next.catch(() => { }));
    return next;
}

function _charDirFor(baseDir, characterName) {
    return path.join(baseDir || DEFAULT_CHATS_DIR, characterName);
}

async function listChatFiles(characterName, baseDir = DEFAULT_CHATS_DIR) {
    const dir = _charDirFor(baseDir, characterName);
    try {
        const files = await fs.promises.readdir(dir);
        const full = await Promise.all(files.map(async f => {
            const stat = await fs.promises.stat(path.join(dir, f));
            return { name: f, mtime: stat.mtimeMs };
        }));
        full.sort((a, b) => b.mtime - a.mtime);
        return full.map(x => x.name);
    } catch (err) {
        return [];
    }
}

async function readLatestChat(characterName, baseDir = DEFAULT_CHATS_DIR) {
    const dir = _charDirFor(baseDir, characterName);
    const files = await listChatFiles(characterName, baseDir);
    if (!files || files.length === 0) return [];
    const latest = path.join(dir, files[0]);
    const txt = await fs.promises.readFile(latest, 'utf8');
    const lines = txt.split(/\r?\n/).filter(Boolean);
    return lines.map(l => {
        try { return JSON.parse(l); } catch (e) { return { raw: l }; }
    });
}

async function appendMessage(characterName, messageObj, baseDir = DEFAULT_CHATS_DIR, targetFile = null) {
    const dir = _charDirFor(baseDir, characterName);
    await fs.promises.mkdir(dir, { recursive: true });

    let filePath;
    if (targetFile) {
        filePath = path.join(dir, targetFile);
    } else {
        const files = await listChatFiles(characterName, baseDir);
        if (files.length === 0) {
            const fname = `${Date.now()}.jsonl`;
            filePath = path.join(dir, fname);
        } else {
            filePath = path.join(dir, files[0]);
        }
    }

    const payload = JSON.stringify(messageObj) + '\n';
    const key = path.resolve(filePath);
    return _enqueue(key, async () => {
        await fs.promises.appendFile(filePath, payload, 'utf8');
    });
}

function constructStMessage({ role = 'user', content = '', name = null, user_id = null, time = null }) {
    return {
        id: `${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        role,
        name,
        user_id,
        content,
        time: time || Date.now(),
    };
}

module.exports = {
    listChatFiles,
    readLatestChat,
    appendMessage,
    constructStMessage,
    DEFAULT_CHATS_DIR,
};
