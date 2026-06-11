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

    return {
        oc_agent_id: typeof link.oc_agent_id === 'string' ? link.oc_agent_id : null,
        active: Boolean(link.active),
        owner_user_ids: Array.isArray(link.owner_user_ids) ? link.owner_user_ids.slice() : [],
    };
}

function upsertLink(characterName, patch) {
    const state = readState();
    const current = getLink(characterName) || {
        oc_agent_id: null,
        active: false,
        owner_user_ids: [],
    };

    const next = {
        oc_agent_id: typeof patch.oc_agent_id === 'string' ? patch.oc_agent_id.trim() : current.oc_agent_id,
        active: typeof patch.active === 'boolean' ? patch.active : current.active,
        owner_user_ids: Array.isArray(patch.owner_user_ids)
            ? patch.owner_user_ids.filter(x => typeof x === 'string').map(x => x.trim())
            : (Array.isArray(current.owner_user_ids) ? current.owner_user_ids.slice() : []),
    };

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