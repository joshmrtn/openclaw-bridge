const fs = require('fs');
const path = require('path');

let _queue = Promise.resolve();
function _enqueue(fn) {
    const next = _queue.then(() => fn());
    _queue = next.catch(() => {});
    return next;
}

function getLinksPath() {
    if (process.env.OPENCLAW_BRIDGE_LINKS_PATH) {
        return process.env.OPENCLAW_BRIDGE_LINKS_PATH;
    }

    return path.join(__dirname, '..', 'data', 'openclaw-bridge', 'character-links.json');
}

async function _nextCorruptPath(filePath) {
    const base = filePath + '.corrupt';
    try {
        await fs.promises.access(base);
    } catch (_) {
        return base;
    }
    for (let n = 2; ; n++) {
        const candidate = `${base}.${n}`;
        try {
            await fs.promises.access(candidate);
        } catch (_) {
            return candidate;
        }
    }
}

async function readState() {
    const filePath = getLinksPath();
    let raw;
    try {
        raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        throw err;
    }
    if (!raw || !raw.trim()) return {};
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        const corruptPath = await _nextCorruptPath(filePath);
        try { await fs.promises.writeFile(corruptPath, raw, 'utf8'); } catch (_2) {}
        throw new Error(`character-links.json is corrupt (backed up to ${corruptPath}); refusing to overwrite to prevent data loss`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const corruptPath = await _nextCorruptPath(filePath);
        try { await fs.promises.writeFile(corruptPath, raw, 'utf8'); } catch (_2) {}
        throw new Error(`character-links.json has invalid structure (expected object); backed up to ${corruptPath}`);
    }
    return parsed;
}

async function writeState(state) {
    const filePath = getLinksPath();
    const tmpPath = filePath + '.tmp';
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    await fs.promises.rename(tmpPath, filePath);
}

function getLink(characterName) {
    const filePath = getLinksPath();
    let state = {};
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw || '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                state = parsed;
            }
        }
    } catch (_) {}
    const link = state?.[characterName];
    if (!link || typeof link !== 'object' || Array.isArray(link)) {
        return null;
    }

    const result = {
        oc_agent_id: typeof link.oc_agent_id === 'string' ? link.oc_agent_id : null,
        active: Boolean(link.active),
        owner_user_ids: Array.isArray(link.owner_user_ids) ? link.owner_user_ids.slice() : [],
    };

    if (link.heartbeat && typeof link.heartbeat === 'object' && !Array.isArray(link.heartbeat)) {
        result.heartbeat = { ...link.heartbeat };
    }

    if (Array.isArray(link.channels)) {
        result.channels = link.channels.map(ch => ({ ...ch }));
    }

    if (link.tools && typeof link.tools === 'object' && !Array.isArray(link.tools)) {
        result.tools = { ...link.tools };
    }

    return result;
}

function upsertLink(characterName, patch) {
    return _enqueue(async () => {
        const state = await readState();
        const existing = state[characterName] || {};

        const next = {
            ...existing,
            oc_agent_id: typeof patch.oc_agent_id === 'string' ? patch.oc_agent_id.trim() : (typeof existing.oc_agent_id === 'string' ? existing.oc_agent_id : null),
            active: typeof patch.active === 'boolean' ? patch.active : Boolean(existing.active),
            owner_user_ids: Array.isArray(patch.owner_user_ids)
                ? patch.owner_user_ids.filter(x => typeof x === 'string').map(x => x.trim())
                : (Array.isArray(existing.owner_user_ids) ? existing.owner_user_ids.slice() : []),
        };

        if ('heartbeat' in patch) {
            if (patch.heartbeat === null) {
                delete next.heartbeat;
            } else if (patch.heartbeat && typeof patch.heartbeat === 'object' && !Array.isArray(patch.heartbeat)) {
                next.heartbeat = { ...patch.heartbeat };
            }
        }

        if ('channels' in patch) {
            if (patch.channels === null) {
                delete next.channels;
            } else if (Array.isArray(patch.channels)) {
                next.channels = patch.channels.map(ch => ({ ...ch }));
            }
        }

        if ('tools' in patch) {
            if (patch.tools === null) {
                delete next.tools;
            } else if (patch.tools && typeof patch.tools === 'object' && !Array.isArray(patch.tools)) {
                next.tools = { ...patch.tools };
            }
        }

        state[characterName] = next;
        await writeState(state);
        return next;
    });
}

function removeLink(characterName) {
    return _enqueue(async () => {
        const state = await readState();
        if (!Object.prototype.hasOwnProperty.call(state, characterName)) {
            return false;
        }

        delete state[characterName];
        await writeState(state);
        return true;
    });
}

module.exports = {
    getLink,
    upsertLink,
    removeLink,
};