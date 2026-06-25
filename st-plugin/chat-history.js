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
    const base = path.resolve(baseDir || DEFAULT_CHATS_DIR);
    const resolved = path.resolve(base, characterName);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
        throw new Error(`Invalid character name: path traversal detected`);
    }
    return resolved;
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

// Reads the last ~4 KB of filePath and returns true if any JSONL line has the
// given exchange_id. Used to skip duplicate writes on retry.
async function _hasExchangeId(filePath, exchangeId) {
    try {
        const stat = await fs.promises.stat(filePath).catch(() => null);
        if (!stat || stat.size === 0) return false;
        const bytesToRead = Math.min(stat.size, 4096);
        const buf = Buffer.alloc(bytesToRead);
        const fh = await fs.promises.open(filePath, 'r');
        await fh.read(buf, 0, bytesToRead, stat.size - bytesToRead);
        await fh.close();
        for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
            try {
                if (JSON.parse(line).exchange_id === exchangeId) return true;
            } catch (_) {}
        }
    } catch (_) {}
    return false;
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

function constructStMessage({ role = 'user', content = '', name = null, user_id = null, time = null, force_avatar = null, exchange_id = null }) {
    const sendDate = new Date(time || Date.now()).toISOString();
    const baseMessage = {
        name,
        is_user: role === 'user',
        is_system: role === 'system',
        send_date: sendDate,
        mes: content,
        ...(exchange_id ? { exchange_id } : {}),
    };

    if (role === 'system') {
        // System notes (e.g. failed-action logs) should render as subtle,
        // avatar-less lines. Without is_system + a name, ST falls back to the
        // active character's avatar and shows no name (see #233).
        baseMessage.name = name || 'System';
        baseMessage.extra = { isSmallSys: true };
    } else if (role === 'user') {
        baseMessage.extra = {
            isSmallSys: false,
            reasoning: '',
        };
        if (user_id) {
            baseMessage.user_id = user_id;
        }
        baseMessage.force_avatar = force_avatar || '/thumbnail?type=persona&file=user-default.png';
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

async function appendExternalChatToHistory(characterName, userMessage, response, baseDir = DEFAULT_CHATS_DIR, targetFile = null, exchangeId = null) {
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

    const { user_name = null, user_avatar = null, channel = null, user_id = null } = userMessage;
    // Resolve the channel TYPE to show as the message source. Prefer the prefix of
    // the channel-prefixed user_id ("discord:123" -> "discord"), the same token OC
    // hands us for trust labels; fall back to the type segment of the channel account
    // id ("discord-frog" -> "discord"). Whatever OC's channel is (discord/telegram/
    // qa/...) is passed through and capitalised — no per-channel whitelist.
    const channelType = (user_id && user_id.includes(':'))
        ? user_id.slice(0, user_id.indexOf(':'))
        : (channel ? String(channel).split('-')[0] : null);
    const channelLabel = channelType
        ? channelType.charAt(0).toUpperCase() + channelType.slice(1)
        : null;
    let displayName = 'ExternalChat';
    if (user_name) {
        displayName = channelLabel ? `${user_name} (${channelLabel})` : user_name;
    } else if (user_id) {
        const bareId = user_id.includes(':') ? user_id.slice(user_id.indexOf(':') + 1) : user_id;
        displayName = channelLabel ? `${channelLabel} user ${bareId}` : `user ${bareId}`;
    }

    const userContent = buildExternalChatContent(userMessage.message || '', userMessage.images || []);
    const userEntry = constructStMessage({ role: 'user', content: userContent, name: displayName, user_id: userMessage.user_id || null, force_avatar: user_avatar || null, exchange_id: exchangeId });
    const assistantEntry = constructStMessage({ role: 'assistant', content: response, name: characterName, exchange_id: exchangeId });

    const filePath = path.join(dir, resolvedFile);
    const key = path.resolve(filePath);

    return _enqueue(key, async () => {
        // R3.3: idempotency — skip the write if this exchange_id is already in the file
        // (handles retries after a crash mid-write or a duplicate delivery from OC).
        if (exchangeId && await _hasExchangeId(filePath, exchangeId)) {
            return;
        }

        // R3.2: write both entries in a single appendFile call to minimise the crash
        // window. For typical message sizes (<4 KB combined) this is effectively
        // atomic at the OS page-cache level.
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

        await fs.promises.appendFile(
            filePath,
            prefix + JSON.stringify(userEntry) + '\n' + JSON.stringify(assistantEntry) + '\n',
            'utf8'
        );
    });
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
