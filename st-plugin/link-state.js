const fs = require('fs');
const path = require('path');

function getLinksPath() {
    if (process.env.OPENCLAW_BRIDGE_LINKS_PATH) {
        return process.env.OPENCLAW_BRIDGE_LINKS_PATH;
    }

    return path.join(__dirname, '..', 'data', 'openclaw-bridge', 'character-links.json');
}

function readState() {
    const filePath = getLinksPath();
    if (!fs.existsSync(filePath)) {
        return {};
    }

    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        return parsed;
    } catch (err) {
        return {};
    }
}

function writeState(state) {
    const filePath = getLinksPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
}

function getLink(characterName) {
    const state = readState();
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

    return result;
}

function upsertLink(characterName, patch) {
    const state = readState();
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

    state[characterName] = next;
    writeState(state);
    return next;
}

function removeLink(characterName) {
    const state = readState();
    if (!Object.prototype.hasOwnProperty.call(state, characterName)) {
        return false;
    }

    delete state[characterName];
    writeState(state);
    return true;
}

module.exports = {
    getLink,
    upsertLink,
    removeLink,
};