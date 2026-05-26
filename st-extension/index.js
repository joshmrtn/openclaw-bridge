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

function getCurrentCharacterIndex(context) {
    const currentChatId = typeof context?.getCurrentChatId === 'function' ? context.getCurrentChatId() : null;
    if (!currentChatId || !Array.isArray(context?.characters)) {
        return -1;
    }

    return context.characters.findIndex(character => character?.chat === currentChatId);
}

async function waitForCharacterChat(context, characterIndex, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (getCurrentCharacterIndex(context) === characterIndex) {
            return;
        }

        await new Promise(resolve => setTimeout(resolve, 200));
    }

    throw new Error(`Timed out waiting for character chat to load: ${characterIndex}`);
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
    const { generate, generateQuietPrompt, sendGenerationRequest, selectCharacterById } = context;
    const chid = findCharacterIndex(characterName);

    if (chid === -1) {
        throw new Error(`Character not found: ${characterName}`);
    }

    const previousChid = getCurrentCharacterIndex(context);
    const shouldRestorePreviousCharacter = previousChid !== -1 && previousChid !== chid;

    if (shouldRestorePreviousCharacter && typeof selectCharacterById === 'function') {
        await selectCharacterById(chid, { switchMenu: false });
        await waitForCharacterChat(context, chid);
    }

    let result;

    if (typeof generate === 'function') {
        result = await generate('quiet', {
            quiet_prompt: message,
            force_chid: chid,
            skipWIAN: false,
        });
    } else if (typeof generateQuietPrompt === 'function') {
        try {
            result = await generateQuietPrompt({
                quietPrompt: message,
                forceChId: chid,
                skipWIAN: false,
            });
        } catch (e) {
            result = await generateQuietPrompt({ quietPrompt: message });
        }
    } else if (typeof Generate === 'function') {
        result = await Generate('quiet', {
            quiet_prompt: message,
            force_chid: chid,
            skipWIAN: false,
        });
    } else if (typeof sendGenerationRequest === 'function') {
        result = await sendGenerationRequest('quiet', {
            prompt: message,
            force_chid: chid,
            quiet_prompt: message,
            stream: false,
        });
        if (result && typeof result === 'object' && 'text' in result && typeof result.text === 'string') {
            result = result.text;
        }
    } else {
        throw new Error('No Generate API available in the SillyTavern context');
    }

    if (shouldRestorePreviousCharacter && typeof selectCharacterById === 'function') {
        try {
            await selectCharacterById(previousChid, { switchMenu: false });
            await waitForCharacterChat(context, previousChid);
        } catch (restoreError) {
            console.warn('[openclaw-bridge] Failed to restore previous character chat', restoreError);
        }
    }

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
