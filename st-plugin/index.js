const PLUGIN_ID = 'openclaw-bridge';
const PLUGIN_VERSION = '0.1.0';
const charLoader = require('./character-loader');
const chatHistory = require('./chat-history');
const generator = require('./generator');
const linkState = require('./link-state');
const sessionManager = require('./session-manager');
const { startWebSocketServer } = require('./ws-server');

let wsBundle = null;

function getAuthToken() {
    return process.env.OPENCLAW_BRIDGE_AUTH_TOKEN || process.env.OPENCLAW_BRIDGE_TOKEN || '';
}

function requireBearerToken(request, response, next) {
    const expectedToken = getAuthToken();

    if (!expectedToken) {
        response.status(500).json({ error: 'OpenClaw Bridge auth token is not configured' });
        return;
    }

    const authorization = request.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match || match[1] !== expectedToken) {
        response.status(401).json({ error: 'Unauthorized' });
        return;
    }

    next();
}

function parseDebugFlag(request) {
    const debugValue = request?.body?.debug ?? request?.query?.debug;
    return debugValue === true || debugValue === 'true' || debugValue === '1' || debugValue === 1;
}

function parseActiveFlag(value, defaultValue) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1' || value === 1) return true;
    if (value === 'false' || value === '0' || value === 0) return false;
    return defaultValue;
}

function normalizeCharacterName(rawName = '') {
    return decodeURIComponent(String(rawName || '')).trim();
}

async function ensureCharacterExists(characterName) {
    const chars = await charLoader.listCharacters();
    return chars.some(entry => entry && entry.name === characterName);
}

async function init(router) {
    router.use(requireBearerToken);

    if (!wsBundle) {
        wsBundle = startWebSocketServer({
            port: Number(process.env.OPENCLAW_BRIDGE_WS_PORT || 8765),
            sessionManager,
        });
    }

    router.get('/status', (request, response) => {
        response.json({
            status: 'ok',
            version: PLUGIN_VERSION,
            plugin: PLUGIN_ID,
            connected_ws_clients: sessionManager.getConnectedClientCount(),
        });
    });

    router.get('/characters', async (request, response) => {
        try {
            const chars = await charLoader.listCharacters();
            const activeOnly = parseActiveFlag(request?.query?.active_only, false);
            const merged = chars
                .map(entry => ({
                    ...entry,
                    link: linkState.getLink(entry.name),
                    active: Boolean(linkState.getLink(entry.name)?.active),
                }))
                .filter(entry => !activeOnly || entry.active);

            response.json(merged);
        } catch (err) {
            response.status(500).json({ error: err.message });
        }
    });

    router.post('/characters/:name/link', async (request, response) => {
        const characterName = normalizeCharacterName(request?.params?.name);
        const { oc_agent_id = null, owner_user_ids = null } = request.body || {};

        if (!characterName) {
            response.status(400).json({ error: 'Character name is required' });
            return;
        }

        if (typeof oc_agent_id !== 'string' || !oc_agent_id.trim()) {
            response.status(400).json({ error: 'oc_agent_id is required' });
            return;
        }

        try {
            const exists = await ensureCharacterExists(characterName);
            if (!exists) {
                response.status(404).json({ error: `Character not found: ${characterName}` });
                return;
            }

            const current = linkState.getLink(characterName);
            const requestedActive = parseActiveFlag(request?.body?.active, current?.active ?? true);
            const link = linkState.upsertLink(characterName, {
                oc_agent_id,
                active: requestedActive,
                owner_user_ids,
            });

            response.json({ character: characterName, link });
        } catch (err) {
            response.status(500).json({ error: err.message });
        }
    });

    router.delete('/characters/:name/link', async (request, response) => {
        const characterName = normalizeCharacterName(request?.params?.name);

        if (!characterName) {
            response.status(400).json({ error: 'Character name is required' });
            return;
        }

        try {
            const removed = linkState.removeLink(characterName);
            if (!removed) {
                response.status(404).json({ error: `No link found for character: ${characterName}` });
                return;
            }

            response.json({ character: characterName, removed: true });
        } catch (err) {
            response.status(500).json({ error: err.message });
        }
    });

    router.post('/test-notify', (request, response) => {
        const { character, text } = request.body || {};

        if (!character || !text) {
            response.status(400).json({ error: 'character and text are required' });
            return;
        }

        const delivered = sessionManager.broadcast({
            type: 'notification',
            character,
            text,
            timestamp: Date.now(),
        });

        response.json({ sent: true, delivered });
    });

    // Register log-action before generate so tests that capture the last POST handler
    // (a simplistic router mock) will still see the /generate handler as the final POST.
    router.post('/log-action', async (request, response) => {
        const { character, action_description, channel = null } = request.body || {};

        if (!character || !action_description) {
            response.status(400).json({ error: 'character and action_description required' });
            return;
        }

        try {
            const msg = `[Autonomous action on ${channel || 'unknown channel'}]: ${action_description}`;
            const entry = chatHistory.constructStMessage({ role: 'system', content: msg });
            await chatHistory.appendMessage(character, entry);
            return response.json({ logged: true, character });
        } catch (err) {
            return response.status(500).json({ error: err.message });
        }
    });

    router.post('/generate', async (request, response) => {
        const { character, message, images = [], channel = null, user_id = null } = request.body || {};

        if (!character || !message) {
            response.status(400).json({ error: 'character and message are required' });
            return;
        }

        try {
            let generatedText;
            let shouldWriteHistory = true;

            // Try to label message with owner/guest if link exists
            try {
                const links = linkState.getLink(character) || {};
                const ownerIds = links?.owner_user_ids ?? [];
                const isOwner = user_id && ownerIds.includes(user_id);
                const trustLabel = isOwner ? '[OWNER]' : '[GUEST]';
                const labeledMessage = `${trustLabel}\n${message}`;

                try {
                    generatedText = await sessionManager.requestGenerate({
                        character,
                        message: labeledMessage,
                        images,
                        channel,
                        user_id,
                    });
                } catch (wsError) {
                    const result = await generator.generate(character, labeledMessage, { images, channel, user_id });
                    generatedText = typeof result === 'string' ? result : result?.response;
                    shouldWriteHistory = false;
                }
            } catch (innerErr) {
                // No link state or error reading it; try without label
                try {
                    generatedText = await sessionManager.requestGenerate({ character, message, images, channel, user_id });
                } catch (wsError) {
                    const result = await generator.generate(character, message, { images, channel, user_id });
                    generatedText = typeof result === 'string' ? result : result?.response;
                    shouldWriteHistory = false;
                }
            }

            if (shouldWriteHistory) {
                await chatHistory.appendExternalChatToHistory(character, { message, images, user_id }, generatedText);
            }

            const result = { character, response: generatedText };
            response.json(result);
        } catch (err) {
            response.status(500).json({ error: err.message });
        }
    });
}

module.exports = {
    info: {
        id: PLUGIN_ID,
        name: 'OpenClaw Bridge',
        description: 'Server plugin for bridging SillyTavern characters to OpenClaw.',
    },
    init,
};
