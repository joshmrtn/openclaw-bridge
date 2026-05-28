import { getContext } from '/script.js';

const STATE = {
    socket: null,
    connected: false,
    reconnectTimer: null,
    pending: new Map(),
    characterLocks: new Map(),
    notificationRoot: null,
    notificationList: null,
    notificationsCollapsed: false,
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

function ensureNotificationPanel() {
    if (STATE.notificationRoot) {
        return STATE.notificationRoot;
    }

    const root = document.createElement('div');
    root.id = 'openclaw-bridge-notifications';
    root.className = 'openclaw-bridge-panel is-hidden';

    const header = document.createElement('div');
    header.className = 'openclaw-bridge-panel__header';

    const title = document.createElement('span');
    title.className = 'openclaw-bridge-panel__title';
    title.textContent = 'External Presence';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'openclaw-bridge-panel__toggle';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.textContent = '▾';

    toggle.addEventListener('click', () => {
        STATE.notificationsCollapsed = !STATE.notificationsCollapsed;
        root.classList.toggle('is-collapsed', STATE.notificationsCollapsed);
        toggle.setAttribute('aria-expanded', String(!STATE.notificationsCollapsed));
        toggle.textContent = STATE.notificationsCollapsed ? '▸' : '▾';
    });

    header.append(title, toggle);

    const list = document.createElement('div');
    list.className = 'openclaw-bridge-panel__list';

    root.append(header, list);
    document.body.append(root);

    STATE.notificationRoot = root;
    STATE.notificationList = list;

    return root;
}

function formatNotificationTime(timestamp) {
    if (!timestamp) return '';
    try {
        return new Date(timestamp).toLocaleTimeString();
    } catch (error) {
        return '';
    }
}

function addNotification({ character, text, timestamp }) {
    if (!text) return;

    const root = ensureNotificationPanel();
    const list = STATE.notificationList;
    if (!list) return;

    root.classList.remove('is-hidden');

    const item = document.createElement('div');
    item.className = 'openclaw-bridge-notification';

    const content = document.createElement('div');
    content.className = 'openclaw-bridge-notification__content';
    content.textContent = text;

    const meta = document.createElement('div');
    meta.className = 'openclaw-bridge-notification__meta';
    const timeLabel = formatNotificationTime(timestamp || Date.now());
    meta.textContent = `${character || 'Unknown'}${timeLabel ? ` • ${timeLabel}` : ''}`;

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'openclaw-bridge-notification__dismiss';
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => item.remove());

    item.append(content, meta, dismiss);
    list.prepend(item);

    while (list.children.length > 20) {
        list.lastChild?.remove();
    }
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
            return;
        }

        if (payload.type === 'notification') {
            addNotification(payload);
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
