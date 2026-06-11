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

    const line = JSON.stringify(messageObj) + '\n';
    const key = path.resolve(filePath);
    return _enqueue(key, async () => {
        // JSONL requires one object per line. If the file exists but doesn't end
        // with \n (e.g. written by ST's trySaveChat which uses join('\n')), a plain
        // appendFile would merge our entry onto the last line. Peek at the last byte
        // and prepend \n when needed so the entry always starts on its own line.
        let prefix = '';
        try {
            const stat = await fs.promises.stat(filePath).catch(() => null);
            if (stat && stat.size > 0) {
                const buf = Buffer.alloc(1);
                const fh = await fs.promises.open(filePath, 'r');
                await fh.read(buf, 0, 1, stat.size - 1);
                await fh.close();
                if (buf[0] !== 0x0a) prefix = '\n'; // file does not end with \n
            }
        } catch (_) {}
        await fs.promises.appendFile(filePath, prefix + line, 'utf8');
    });
}

function constructStMessage({ role = 'user', content = '', name = null, user_id = null, time = null }) {
    const sendDate = new Date(time || Date.now()).toISOString();
    const baseMessage = {
        name,
        is_user: role === 'user',
        is_system: false,
        send_date: sendDate,
        mes: content,
    };

    if (role === 'user') {
        baseMessage.extra = {
            isSmallSys: false,
            reasoning: '',
        };
        if (user_id) {
            baseMessage.user_id = user_id;
        }
        baseMessage.force_avatar = '/thumbnail?type=persona&file=user-default.png';
    } else if (role === 'assistant') {
        const now = new Date().toISOString();
        baseMessage.extra = {
            api: 'custom',
            model: 'openclaw-bridge',
        };
        baseMessage.title = '';
        baseMessage.gen_started = sendDate;
        baseMessage.gen_finished = now;
        baseMessage.swipes = [content];
        baseMessage.swipe_id = 0;
        baseMessage.swipe_info = [{
            send_date: now,
            gen_started: sendDate,
            gen_finished: now,
        }];
    }

    return baseMessage;
}

function buildExternalChatContent(message, images = []) {
    if (!Array.isArray(images) || images.length === 0) {
        return message;
    }

    return [
        { type: 'text', text: message },
        ...images.map(image => ({
            type: 'image_url',
            image_url: { url: image },
        })),
    ];
}

async function appendExternalChatToHistory(characterName, userMessage, response, baseDir = DEFAULT_CHATS_DIR, targetFile = null) {
    const dir = _charDirFor(baseDir, characterName);
    await fs.promises.mkdir(dir, { recursive: true });

    let resolvedFile;
    if (targetFile) {
        resolvedFile = targetFile;
    } else {
        const files = await listChatFiles(characterName, baseDir);
        if (files.length === 0) {
            // No existing chat — bootstrap a new file with the ST header entry
            const fname = `${Date.now()}.jsonl`;
            const header = { chat_metadata: {}, user_name: 'unused', character_name: characterName };
            await fs.promises.writeFile(path.join(dir, fname), JSON.stringify(header) + '\n', 'utf8');
            resolvedFile = fname;
        } else {
            resolvedFile = files[0];
        }
    }

    const userContent = buildExternalChatContent(userMessage.message || '', userMessage.images || []);
    const userEntry = constructStMessage({ role: 'user', content: userContent, name: 'ExternalChat', user_id: userMessage.user_id || null });
    const assistantEntry = constructStMessage({ role: 'assistant', content: response, name: characterName });

    // Append both entries. appendMessage handles the case where the file doesn't
    // end with \n (written by ST's own save path which uses join('\n')).
    await appendMessage(characterName, userEntry, baseDir, resolvedFile);
    await appendMessage(characterName, assistantEntry, baseDir, resolvedFile);
}

module.exports = {
    listChatFiles,
    readLatestChat,
    appendMessage,
    constructStMessage,
    buildExternalChatContent,
    appendExternalChatToHistory,
    DEFAULT_CHATS_DIR,
};
