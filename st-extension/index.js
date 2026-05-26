import { getContext } from '/script.js';

const STATE = {
    socket: null,
    connected: false,
    reconnectTimer: null,
    pending: new Map(),
    characterLocks: new Map(),
};

function getStContext() {
    if (globalThis.SillyTavern?.getContext) {
        return globalThis.SillyTavern.getContext();
    }

    return getContext();
}

function getCharacters() {
    const context = getStContext();
    return Array.isArray(context?.characters) ? context.characters : [];
}

function findCharacterIndex(characterName) {
    return getCharacters().findIndex(character => character?.name === characterName);
}

function normalizeGenerationResult(result) {
    if (typeof result === 'string') {
        return result;
    }

    return result?.text || result?.response || result?.message || JSON.stringify(result);
}

function withCharacterLock(characterName, task) {
    const previous = STATE.characterLocks.get(characterName) || Promise.resolve();
    const next = previous.then(task, task);
    STATE.characterLocks.set(characterName, next.catch(() => { }));
    return next;
}

async function generateForCharacter(characterName, message) {
    const context = getStContext();
    const { Generate } = context;
    const chid = findCharacterIndex(characterName);

    if (chid === -1) {
        throw new Error(`Character not found: ${characterName}`);
    }

    if (typeof Generate !== 'function') {
        throw new Error('Generate() is not available in the SillyTavern context');
    }

    const result = await Generate('quiet', {
        quiet_prompt: message,
        force_chid: chid,
        skipWIAN: false,
    });

    return normalizeGenerationResult(result);
}

async function handleGenerateRequest(payload) {
    const { requestId, character, message } = payload;

    try {
        const response = await withCharacterLock(character, () => generateForCharacter(character, message));
        sendSocketMessage({
            type: 'generate_response',
            requestId,
            response,
        });
    } catch (error) {
        sendSocketMessage({
            type: 'generate_error',
            requestId,
            error: error?.message || String(error),
        });
    }
}

function sendSocketMessage(payload) {
    if (!STATE.socket || STATE.socket.readyState !== WebSocket.OPEN) {
        return;
    }

    STATE.socket.send(JSON.stringify(payload));
}

function connect() {
    if (STATE.socket && (STATE.socket.readyState === WebSocket.OPEN || STATE.socket.readyState === WebSocket.CONNECTING)) {
        return;
    }

    const socket = new WebSocket('ws://localhost:8765');
    STATE.socket = socket;

    socket.addEventListener('open', () => {
        STATE.connected = true;
        console.info('[openclaw-bridge] WebSocket connected');
    });

    socket.addEventListener('message', async event => {
        let payload;

        try {
            payload = JSON.parse(event.data);
        } catch (error) {
            return;
        }

        if (payload.type === 'generate') {
            await handleGenerateRequest(payload);
        }
    });

    socket.addEventListener('close', () => {
        STATE.connected = false;
        if (STATE.reconnectTimer) {
            clearTimeout(STATE.reconnectTimer);
        }
        STATE.reconnectTimer = setTimeout(connect, 1000);
    });

    socket.addEventListener('error', () => {
        STATE.connected = false;
    });
}

function init() {
    globalThis.openclawBridge = {
        connect,
        generateForCharacter,
        withCharacterLock,
        state: STATE,
    };

    connect();
}

export {
    init,
    generateForCharacter,
};

globalThis.openclawBridgeInit = init;
