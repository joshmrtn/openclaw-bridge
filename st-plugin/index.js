const PLUGIN_ID = 'openclaw-bridge';
const PLUGIN_VERSION = '0.1.0';
const charLoader = require('./character-loader');
const chatHistory = require('./chat-history');
const generator = require('./generator');
const sessionManager = require('./session-manager');
const { startWebSocketServer } = require('./ws-server');

let wsBundle = null;

function getAuthToken() {
    return process.env.OPENCLAW_BRIDGE_AUTH_TOKEN || process.env.OPENCLAW_BRIDGE_TOKEN || '';
}

function requireBearerToken(request, response, next) {
    const expectedToken = getAuthToken();

    if (!expectedToken) {
        response.status(500).json({
            error: 'OpenClaw Bridge auth token is not configured',
        });
        return;
    }

    const authorization = request.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match || match[1] !== expectedToken) {
        response.status(401).json({
            error: 'Unauthorized',
        });
        return;
    }

    next();
}

function parseDebugFlag(request) {
    const debugValue = request?.body?.debug ?? request?.query?.debug;
    if (debugValue === true || debugValue === 'true' || debugValue === '1' || debugValue === 1) {
        return true;
    }
    return false;
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
            response.json(chars);
        } catch (err) {
            response.status(500).json({ error: err.message });
        }
    });

    router.post('/generate', async (request, response) => {
        const { character, message, images = [], channel = null, user_id = null } = request.body || {};

        if (!character || !message) {
            response.status(400).json({
                error: 'character and message are required',
            });
            return;
        }

        try {
            let generatedText;
            let shouldWriteHistory = true;

            try {
                generatedText = await sessionManager.requestGenerate({
                    character,
                    message,
                    images,
                    channel,
                    user_id,
                });
            } catch (wsError) {
                const result = await generator.generate(character, message, {
                    images,
                    channel,
                    user_id,
                });
                generatedText = result.response;
                shouldWriteHistory = false;
            }

            if (shouldWriteHistory) {
                await chatHistory.appendDiscordMessageToHistory(
                    character,
                    {
                        message,
                        images,
                        user_id,
                    },
                    generatedText,
                );
            }

            const result = {
                character,
                response: generatedText,
            };

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
