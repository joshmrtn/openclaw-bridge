const fs = require('fs');
const path = require('path');

console.info('[openclaw-bridge-plugin] ===== INDEX.JS LOADED =====');

const PLUGIN_ID = 'openclaw-bridge';
const PLUGIN_VERSION = '0.1.0';
const charLoader = require('./character-loader');
const chatHistory = require('./chat-history');
const generator = require('./generator');
const linkState = require('./link-state');
const sessionManager = require('./session-manager');
const { startWebSocketServer } = require('./ws-server');
const headlessService = require('./headless-service');

let wsBundle = null;
let headlessStartupError = null;

function getAuthToken() {
    const envToken = process.env.OPENCLAW_BRIDGE_AUTH_TOKEN || process.env.OPENCLAW_BRIDGE_TOKEN;
    if (envToken) return envToken;

    const configuredPath = process.env.OPENCLAW_BRIDGE_TOKEN_PATH;
    const candidatePaths = [
        configuredPath,
        path.resolve(__dirname, '../data/openclaw-bridge/bridge-token.txt'),
        path.resolve(process.cwd(), '../data/openclaw-bridge/bridge-token.txt'),
        path.resolve(process.cwd(), 'data/openclaw-bridge/bridge-token.txt'),
    ].filter(Boolean);

    for (const tokenPath of candidatePaths) {
        try {
            if (!fs.existsSync(tokenPath)) continue;
            const fileToken = fs.readFileSync(tokenPath, 'utf8').trim();
            if (fileToken) return fileToken;
        } catch (err) {
            // Keep trying other candidate paths.
        }
    }

    return '';
}

function requireBearerToken(request, response, next) {
    const expectedToken = getAuthToken();
    const csrfToken = request.get('x-csrf-token');

    if (csrfToken) {
        next();
        return;
    }

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

function isWsUnavailableError(error) {
    const msg = error?.message || '';
    return msg.includes('No connected extension client') || msg.includes('Timed out waiting for generation response');
}

async function ensureCharacterExists(characterName) {
    const chars = await charLoader.listCharacters();
    return chars.some(entry => entry && entry.name === characterName);
}

async function init(router) {
    console.info('[openclaw-bridge-plugin] ===== PLUGIN INIT CALLED =====');
    router.use(requireBearerToken);

    if (!wsBundle) {
        console.info('[openclaw-bridge-plugin] Starting WebSocket server...');
        wsBundle = startWebSocketServer({
            port: Number(process.env.OPENCLAW_BRIDGE_WS_PORT || 8765),
            sessionManager,
        });
        console.info('[openclaw-bridge-plugin] WebSocket server bundle created');
    } else {
        console.info('[openclaw-bridge-plugin] WebSocket server already running');
    }

    // Start headless service in the background so it doesn't block plugin init.
    // It retries page.goto if ST isn't listening yet (race condition on startup).
    const enableHeadless = (process.env.OPENCLAW_BRIDGE_ENABLE_HEADLESS !== 'false');
    if (enableHeadless) {
        headlessStartupError = null;
        console.info('[openclaw-bridge-plugin] Starting headless browser service in background...');
        headlessService.start({
            stUrl: process.env.OPENCLAW_BRIDGE_ST_URL || 'http://127.0.0.1:8000',
            timeoutMs: Number(process.env.OPENCLAW_BRIDGE_HEADLESS_STARTUP_TIMEOUT_MS || 30000),
            onError: (err) => {
                headlessStartupError = err;
                console.error('[openclaw-bridge-plugin] Headless service error:', err.message);
            },
        }).then(() => {
            console.info('[openclaw-bridge-plugin] Headless service started');
        }).catch(err => {
            headlessStartupError = err;
            console.warn('[openclaw-bridge-plugin] Headless service startup failed (plugin will continue without headless):', err.message);
        });
    }

    // POST /reload-headless — forces the headless browser to reload so it picks up
    // any settings changes made in the ST UI (e.g. model, API endpoint, persona).
    router.post('/reload-headless', async (request, response) => {
        if (!headlessService.isConnected()) {
            return response.status(503).json({ error: 'Headless service not connected or not running' });
        }
        try {
            await headlessService.reloadPage();
            return response.json({ reloaded: true });
        } catch (err) {
            return response.status(500).json({ error: err.message });
        }
    });

    router.get('/status', (request, response) => {
        response.json({
            status: 'ok',
            version: PLUGIN_VERSION,
            plugin: PLUGIN_ID,
            connected_ws_clients: sessionManager.getConnectedClientCount(),
        });
    });

    router.get('/health', (request, response) => {
        const clientStatus = sessionManager.getClientStatus();
        const headlessStatus = headlessService.getStatus();
        response.json({
            plugin: PLUGIN_ID,
            version: PLUGIN_VERSION,
            uptime: process.uptime(),
            clients: clientStatus,
            headless: headlessStatus,
            headlessError: headlessStartupError?.message || null,
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

    // HTTP polling endpoints for extension fallback
    router.get('/http-message', (request, response) => {
        try {
            const msg = sessionManager.popHttpOutboundMessage();
            if (!msg) {
                // No message available — return 204 so client can poll later
                return response.status(204).end();
            }

            return response.json(msg);
        } catch (err) {
            return response.status(500).json({ error: err.message });
        }
    });

    router.post('/http-response', (request, response) => {
        try {
            const body = request.body || {};
            const handled = sessionManager.handleHttpResponse(body);
            if (!handled) {
                return response.status(404).json({ handled: false });
            }
            return response.json({ handled: true });
        } catch (err) {
            return response.status(500).json({ error: err.message });
        }
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
        const allowFallback = String(process.env.OPENCLAW_BRIDGE_ALLOW_FALLBACK || '').toLowerCase() === 'true';

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
                    if (!allowFallback) {
                        wsError.statusCode = 503;
                        throw wsError;
                    }
                    const result = await generator.generate(character, labeledMessage, { images, channel, user_id });
                    generatedText = typeof result === 'string' ? result : result?.response;
                    shouldWriteHistory = false;
                }
            } catch (innerErr) {
                // No link state or error reading it; try without label
                try {
                    generatedText = await sessionManager.requestGenerate({ character, message, images, channel, user_id });
                } catch (wsError) {
                    if (!allowFallback) {
                        wsError.statusCode = 503;
                        throw wsError;
                    }
                    const result = await generator.generate(character, message, { images, channel, user_id });
                    generatedText = typeof result === 'string' ? result : result?.response;
                    shouldWriteHistory = false;
                }
            }

            if (shouldWriteHistory) {
                await chatHistory.appendExternalChatToHistory(character, { message, images, user_id }, generatedText);

                // Notify connected extension clients that a chat file was updated so frontends can reload.
                try {
                    sessionManager.broadcast({
                        type: 'chat_updated',
                        character,
                        user_id: user_id || null,
                        timestamp: Date.now(),
                    });
                } catch (bcastErr) {
                    console.warn('[openclaw-bridge-plugin] Failed to broadcast chat_updated:', bcastErr?.message || bcastErr);
                }
            }

            const result = { character, response: generatedText };
            response.json(result);
        } catch (err) {
            const status = err?.statusCode || (isWsUnavailableError(err) ? 503 : 500);
            response.status(status).json({ error: err.message });
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
