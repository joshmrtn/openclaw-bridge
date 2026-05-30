let eventSource, event_types, getContext, getRequestHeaders;

function ensureSillyTavernApis() {
    if (globalThis.SillyTavern?.getContext) {
        const context = globalThis.SillyTavern.getContext();
        if (context) {
            eventSource = context.eventSource || eventSource;
            event_types = context.eventTypes || event_types;
            getRequestHeaders = context.getRequestHeaders || getRequestHeaders;
        }
    }

    if (typeof window !== 'undefined') {
        getContext = getContext || window.getContext;
        eventSource = eventSource || window.eventSource;
        event_types = event_types || window.event_types;
        getRequestHeaders = getRequestHeaders || window.getRequestHeaders;
    }
}


const STATE = {
    socket: null,
    connected: false,
    reconnectTimer: null,
    pending: new Map(),
    characterLocks: new Map(),
    notificationRoot: null,
    notificationList: null,
    notificationsCollapsed: false,
    managementRoot: null,
    managementStatus: null,
    managementFields: null,
    managementLoading: false,
    activeCharacterName: null,
};

function getStContext() {
    if (globalThis.SillyTavern?.getContext) {
        return globalThis.SillyTavern.getContext();
    }

    if (typeof getContext === 'function') {
        return getContext();
    }

    return {};
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

function resolveCharacterName() {
    const input = document.getElementById('character_name_pole');
    const value = input?.value?.trim();
    if (value) return value;

    const context = getStContext();
    const idx = typeof context?.characterId === 'number' ? context.characterId : -1;
    if (idx >= 0 && Array.isArray(context?.characters)) {
        return context.characters[idx]?.name || '';
    }
    return '';
}

function buildPluginHeaders({ omitContentType = false } = {}) {
    const contextHeaders = getStContext()?.getRequestHeaders;
    if (typeof contextHeaders === 'function') {
        return contextHeaders({ omitContentType });
    }
    if (typeof getRequestHeaders === "function") {
        return getRequestHeaders({ omitContentType });
    }
    return {};
}

function setManagementStatus(message, tone = 'info') {
    if (!STATE.managementStatus) return;
    STATE.managementStatus.textContent = message;
    STATE.managementStatus.classList.remove('is-error', 'is-success', 'is-muted');
    if (tone === 'error') {
        STATE.managementStatus.classList.add('is-error');
    } else if (tone === 'success') {
        STATE.managementStatus.classList.add('is-success');
    } else if (tone === 'muted') {
        STATE.managementStatus.classList.add('is-muted');
    }
}

function setManagementLoading(isLoading) {
    STATE.managementLoading = isLoading;
    const fields = STATE.managementFields;
    if (!fields) return;
    const { toggleInput, ocAgentInput, ownerIdsInput, saveButton, testButton } = fields;
    [toggleInput, ocAgentInput, ownerIdsInput, saveButton, testButton].forEach(el => {
        if (el) el.disabled = isLoading;
    });
}

function parseOwnerIds(rawValue) {
    if (!rawValue) return [];
    return String(rawValue)
        .split(/[\n,]/)
        .map(value => value.trim())
        .filter(Boolean);
}

function ensureManagementPanel() {
    if (STATE.managementRoot) {
        return STATE.managementRoot;
    }

    const container = document.querySelector('#rm_ch_create_block form');
    if (!container) return null;

    const root = document.createElement('div');
    root.id = 'openclaw-bridge-management';
    root.className = 'openclaw-bridge-card';

    const header = document.createElement('div');
    header.className = 'openclaw-bridge-card__header';

    const title = document.createElement('div');
    title.className = 'openclaw-bridge-card__title';
    title.textContent = 'External Presence';

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'openclaw-bridge-toggle';
    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.className = 'openclaw-bridge-toggle__input';
    const toggleText = document.createElement('span');
    toggleText.textContent = 'Enabled';
    toggleLabel.append(toggleInput, toggleText);

    header.append(title, toggleLabel);

    const body = document.createElement('div');
    body.className = 'openclaw-bridge-card__body';

    const agentField = document.createElement('div');
    agentField.className = 'openclaw-bridge-field';
    const agentLabel = document.createElement('label');
    agentLabel.textContent = 'OC Agent ID';
    const ocAgentInput = document.createElement('input');
    ocAgentInput.type = 'text';
    ocAgentInput.className = 'text_pole';
    ocAgentInput.placeholder = 'e.g. gerard';
    agentField.append(agentLabel, ocAgentInput);

    const ownerField = document.createElement('div');
    ownerField.className = 'openclaw-bridge-field';
    const ownerLabel = document.createElement('label');
    ownerLabel.textContent = 'Owner User IDs';
    const ownerIdsInput = document.createElement('textarea');
    ownerIdsInput.className = 'text_pole textarea_compact';
    ownerIdsInput.rows = 2;
    ownerIdsInput.placeholder = 'discord:1234, telegram:9876';
    const ownerHint = document.createElement('small');
    ownerHint.textContent = 'Comma- or newline-separated. Owners receive [OWNER] label.';
    ownerField.append(ownerLabel, ownerIdsInput, ownerHint);

    const actions = document.createElement('div');
    actions.className = 'openclaw-bridge-actions';
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'openclaw-bridge-button';
    saveButton.textContent = 'Save link';
    const testButton = document.createElement('button');
    testButton.type = 'button';
    testButton.className = 'openclaw-bridge-button';
    testButton.textContent = 'Test connection';
    actions.append(saveButton, testButton);

    const status = document.createElement('div');
    status.className = 'openclaw-bridge-status is-muted';
    status.textContent = 'Not configured.';

    const authNote = document.createElement('small');
    authNote.className = 'openclaw-bridge-status is-muted';
    authNote.textContent = 'Uses current SillyTavern session for auth.';

    body.append(agentField, ownerField, actions, authNote, status);
    root.append(header, body);
    container.append(root);

    STATE.managementRoot = root;
    STATE.managementStatus = status;
    STATE.managementFields = {
        toggleInput,
        ocAgentInput,
        ownerIdsInput,
        saveButton,
        testButton,
    };

    toggleInput.addEventListener('change', () => {
        saveLinkState();
    });

    saveButton.addEventListener('click', () => {
        saveLinkState();
    });

    testButton.addEventListener('click', () => {
        testConnection();
    });

    return root;
}

async function loadLinkState(characterName) {
    if (!characterName) {
        setManagementStatus('Enter a character name to configure.', 'muted');
        return;
    }

    setManagementLoading(true);
    try {
        const response = await fetch('/api/plugins/openclaw-bridge/characters', {
            method: 'GET',
            headers: buildPluginHeaders({ omitContentType: true }),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(text || `Failed to load link state (${response.status})`);
        }

        const characters = await response.json();
        const entry = Array.isArray(characters)
            ? characters.find(item => item?.name === characterName)
            : null;

        const fields = STATE.managementFields;
        if (!fields) return;

        if (entry?.link) {
            fields.ocAgentInput.value = entry.link.oc_agent_id || '';
            fields.ownerIdsInput.value = Array.isArray(entry.link.owner_user_ids)
                ? entry.link.owner_user_ids.join(', ')
                : '';
            fields.toggleInput.checked = Boolean(entry.active);
            setManagementStatus(`Linked as ${entry.link.oc_agent_id || 'unknown'}.`, 'success');
        } else {
            fields.ocAgentInput.value = '';
            fields.ownerIdsInput.value = '';
            fields.toggleInput.checked = false;
            setManagementStatus('Not linked yet.', 'muted');
        }
    } catch (error) {
        setManagementStatus(error?.message || 'Failed to load link state.', 'error');
    } finally {
        setManagementLoading(false);
    }
}

async function saveLinkState() {
    const fields = STATE.managementFields;
    if (!fields) return;

    const characterName = resolveCharacterName();
    if (!characterName) {
        setManagementStatus('Enter a character name before saving.', 'error');
        return;
    }

    const ocAgentId = fields.ocAgentInput.value.trim();
    if (!ocAgentId) {
        setManagementStatus('OC Agent ID is required.', 'error');
        return;
    }

    const ownerIds = parseOwnerIds(fields.ownerIdsInput.value);

    setManagementLoading(true);
    try {
        const response = await fetch(`/api/plugins/openclaw-bridge/characters/${encodeURIComponent(characterName)}/link`, {
            method: 'POST',
            headers: buildPluginHeaders(),
            body: JSON.stringify({
                oc_agent_id: ocAgentId,
                owner_user_ids: ownerIds,
                active: Boolean(fields.toggleInput.checked),
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(text || `Failed to save link (${response.status})`);
        }

        const payload = await response.json();
        fields.toggleInput.checked = Boolean(payload?.link?.active);
        setManagementStatus('Link saved.', 'success');
    } catch (error) {
        setManagementStatus(error?.message || 'Failed to save link.', 'error');
    } finally {
        setManagementLoading(false);
    }
}

async function testConnection() {
    const fields = STATE.managementFields;
    if (!fields) return;

    const characterName = resolveCharacterName();
    if (!characterName) {
        setManagementStatus('Enter a character name before testing.', 'error');
        return;
    }

    setManagementLoading(true);
    try {
        const response = await fetch('/api/plugins/openclaw-bridge/test-notify', {
            method: 'POST',
            headers: buildPluginHeaders(),
            body: JSON.stringify({
                character: characterName,
                text: 'Test notification from SillyTavern UI',
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(text || `Test failed (${response.status})`);
        }

        setManagementStatus('Test notification sent.', 'success');
    } catch (error) {
        setManagementStatus(error?.message || 'Test failed.', 'error');
    } finally {
        setManagementLoading(false);
    }
}

function refreshManagementPanel() {
    const panel = ensureManagementPanel();
    if (!panel) return;

    const characterName = resolveCharacterName();
    STATE.activeCharacterName = characterName || null;
    loadLinkState(characterName);
}

function registerManagementPanelHooks() {
    const context = getStContext();
    const bus = context?.eventSource || eventSource;
    const types = context?.eventTypes || event_types;
    if (!bus || !types?.CHARACTER_EDITOR_OPENED) {
        return;
    }

    const refresh = () => {
        setTimeout(refreshManagementPanel, 0);
    };

    bus.on(types.CHARACTER_EDITOR_OPENED, refresh);
    bus.on(types.CHARACTER_EDITED, refresh);
    bus.on(types.CHARACTER_PAGE_LOADED, refresh);
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

    // Derive WebSocket URL from current location with optional global overrides.
    function getWebSocketUrl() {
        if (globalThis.OPENCLAW_BRIDGE_WS_URL) {
            return globalThis.OPENCLAW_BRIDGE_WS_URL;
        }
        const port = globalThis.OPENCLAW_BRIDGE_WS_PORT || 8765;
        const protocol = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss:' : 'ws:';
        const host = (typeof location !== 'undefined' && location.hostname) ? location.hostname : 'localhost';
        return `${protocol}//${host}:${port}`;
    }

    const socket = new WebSocket(getWebSocketUrl());
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
    ensureSillyTavernApis();
    console.log('[openclaw-bridge] init() called');
    globalThis.openclawBridge = {
        connect,
        generateForCharacter,
        withCharacterLock,
        state: STATE,
    };

    connect();
    registerManagementPanelHooks();
    refreshManagementPanel();
}

export {
    init,
    generateForCharacter,
};

globalThis.openclawBridgeInit = init;
