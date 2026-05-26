const PLUGIN_ID = 'openclaw-bridge';
const PLUGIN_VERSION = '0.1.0';

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

    router.get('/status', (request, response) => {
        response.json({
            status: 'ok',
            version: PLUGIN_VERSION,
            plugin: PLUGIN_ID,
        });
    });

    // Characters listing endpoint
    const charLoader = require('./character-loader');

    router.get('/characters', async (request, response) => {
        try {
            const chars = await charLoader.listCharacters();
            response.json(chars);
        } catch (err) {
            response.status(500).json({ error: err.message });
        }
    });

    const generator = require('./generator');

    router.post('/generate', async (request, response) => {
        const { character, message, images = [], channel = null, user_id = null } = request.body || {};
        const debug = parseDebugFlag(request);

        if (!character || !message) {
            response.status(400).json({
                error: 'character and message are required',
            });
            return;
        }

        try {
            const result = await generator.generate(character, message, {
                images,
                channel,
                user_id,
            });
            const payload = {
                character,
                response: result.response,
            };

            if (debug) {
                payload.assembled = result.assembled;
            }

            response.json(payload);
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
