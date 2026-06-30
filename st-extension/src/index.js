import { ACTION_TOOL_DEFS, ST_SIDE_TOOL_DEFS } from '../../shared/tool-defs.js';

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
    generationLock: Promise.resolve(),
    pendingActions: new Map(),     // characterName → action[] during active generation
    pendingStSideActions: new Map(), // characterName → st_side action[] (lorebook writes, etc.)
    notificationRoot: null,
    notificationList: null,
    notificationsCollapsed: false,
    managementRoot: null,
    managementStatus: null,
    managementFields: null,
    managementLoading: false,
    activeCharacterName: null,
    backoffMs: 1000,           // exponential backoff, start at 1s
    maxBackoffMs: 30000,       // cap at 30s
    healthCheckInterval: null, // health ping timer
    pongReceived: true,        // track if we got a pong back
    pollingInterval: null,     // single shared HTTP polling fallback timer
    newMessageBadge: null,     // "new message" badge element for deferred reload
    connectionId: 0,           // incremented each connect()/connectSse(); stale connections self-close
    lastChatUpdatedTs: 0,      // deduplicate chat_updated when multiple connections are active
    sseAbortController: null,  // AbortController for the active SSE fetch
    sseReconnectTimer: null,   // reconnect backoff timer for SSE
    csrfToken: null,           // explicitly fetched CSRF token for ST's own CSRF middleware
    bridgeToken: null,         // received from plugin via WS welcome; used as Bearer for HTTP calls
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

function stripInstructTemplate(text) {
    if (!text || typeof text !== 'string') return text;

    let s = text;

    // ChatML: extract content of last <|im_start|>assistant block
    const chatMlAssistant = s.lastIndexOf('<|im_start|>assistant');
    if (chatMlAssistant !== -1) {
        const afterNewline = s.indexOf('\n', chatMlAssistant);
        s = afterNewline !== -1 ? s.slice(afterNewline + 1) : s.slice(chatMlAssistant + 21);
    }

    // Llama 3: extract after last <|start_header_id|>assistant<|end_header_id|>
    const llama3Header = s.lastIndexOf('<|start_header_id|>assistant<|end_header_id|>');
    if (llama3Header !== -1) {
        const afterHeader = s.indexOf('\n\n', llama3Header);
        s = afterHeader !== -1 ? s.slice(afterHeader + 2) : s.slice(llama3Header + 45);
    }

    // Mistral/Llama instruct: take everything after last [/INST]
    const lastInstClose = s.lastIndexOf('[/INST]');
    if (lastInstClose !== -1) {
        s = s.slice(lastInstClose + 7);
    }

    // Alpaca/Vicuna: extract after last "### Assistant:\n"
    const alpacaAssistant = s.lastIndexOf('### Assistant:');
    if (alpacaAssistant !== -1) {
        const afterNewline = s.indexOf('\n', alpacaAssistant);
        s = afterNewline !== -1 ? s.slice(afterNewline + 1) : s.slice(alpacaAssistant + 14);
    }

    // Strip stray EOS/boundary tokens
    s = s.replace(/<\|im_end\|>/g, '')
         .replace(/<\|im_start\|>/g, '')
         .replace(/<\|endoftext\|>/g, '')
         .replace(/<\|eot_id\|>/g, '')
         .replace(/<\/s>/g, '')
         .replace(/^<s>/g, '');

    return s.trim();
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
    let headers = {};
    if (typeof contextHeaders === 'function') {
        headers = contextHeaders({ omitContentType });
    } else if (typeof getRequestHeaders === "function") {
        headers = getRequestHeaders({ omitContentType });
    }
    // When the ST context doesn't include a CSRF token (or after a restart clears the
    // session), supplement with our own explicitly fetched token so HTTP POSTs don't 403.
    if (STATE.csrfToken && !headers['x-csrf-token'] && !headers['X-CSRF-Token']) {
        headers = Object.assign({}, headers, { 'X-CSRF-Token': STATE.csrfToken });
    }
    // Authenticate to the bridge plugin using the token received over WebSocket.
    if (STATE.bridgeToken && !headers['authorization'] && !headers['Authorization']) {
        headers = Object.assign({}, headers, { Authorization: `Bearer ${STATE.bridgeToken}` });
    }
    return headers;
}

// Fetch a fresh CSRF token from ST and cache it in STATE.csrfToken.
// Called at init and after any 403 (e.g. ST restarted and cleared its session store).
// The browser handles the session cookie automatically via credentials:'same-origin'.
async function fetchCsrfToken() {
    try {
        const resp = await fetch('/csrf-token', { credentials: 'same-origin' });
        if (!resp.ok) return;
        const data = await resp.json();
        if (typeof data?.token === 'string') {
            STATE.csrfToken = data.token;
            console.info('[openclaw-bridge] CSRF token refreshed');
        }
    } catch (e) {
        // Silent fail — context-provided headers or retry on 403 will handle it
    }
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
    const { toggleInput, ocAgentInput, ownerIdsInput, channelsContainer, saveButton, testButton } = fields;
    [toggleInput, ocAgentInput, ownerIdsInput, saveButton, testButton].forEach(el => {
        if (el) el.disabled = isLoading;
    });
    if (channelsContainer) {
        channelsContainer.querySelectorAll('input, button').forEach(el => {
            el.disabled = isLoading;
        });
    }
}

function parseOwnerIds(rawValue) {
    if (!rawValue) return [];
    return String(rawValue)
        .split(/[\n,]/)
        .map(value => value.trim())
        .filter(Boolean);
}

// #234: warn when External Presence is enabled but the character has no channels
// configured — send_message actions would fail with nowhere to send. Pure so it can be
// unit-tested via the pure-copy pattern. Gated on `active` so reply-only characters that
// intentionally have no channels aren't nagged before they're enabled.
function shouldWarnNoChannels({ active, channelCount }) {
    return Boolean(active) && channelCount === 0;
}

// Recompute the no-channels warning visibility from the live panel state. Called whenever
// channels are loaded, added, removed, or the enable toggle changes.
function updateChannelWarning() {
    const fields = STATE.managementFields;
    if (!fields || !fields.channelWarning) return;
    const channelCount = fields.channelsContainer.querySelectorAll('.openclaw-bridge-channel-row').length;
    const active = Boolean(fields.toggleInput.checked);
    fields.channelWarning.style.display = shouldWarnNoChannels({ active, channelCount }) ? '' : 'none';
}

function renderChannelRow(entry = {}) {
    const row = document.createElement('div');
    row.className = 'openclaw-bridge-channel-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'text_pole openclaw-bridge-channel-name';
    nameInput.placeholder = 'name (e.g. discord)';
    nameInput.value = entry.name || '';

    const idInput = document.createElement('input');
    idInput.type = 'text';
    idInput.className = 'text_pole openclaw-bridge-channel-id';
    idInput.placeholder = 'channel_id (the bot/platform, e.g. discord)';
    idInput.value = entry.channel_id || '';

    // #250: kind decides DM vs channel-post; recipient id is who/where on that platform.
    const kindSelect = document.createElement('select');
    kindSelect.className = 'text_pole openclaw-bridge-channel-kind';
    for (const opt of [['channel', 'channel (post)'], ['dm', 'dm (direct message)']]) {
        const o = document.createElement('option');
        o.value = opt[0];
        o.textContent = opt[1];
        kindSelect.appendChild(o);
    }
    kindSelect.value = entry.kind === 'dm' ? 'dm' : 'channel';

    const recipientInput = document.createElement('input');
    recipientInput.type = 'text';
    recipientInput.className = 'text_pole openclaw-bridge-channel-recipient';
    recipientInput.placeholder = 'recipient id (your user id for dm, channel id for channel)';
    recipientInput.value = entry.id || '';

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'openclaw-bridge-button openclaw-bridge-button--small';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => { row.remove(); updateChannelWarning(); });

    row.append(nameInput, idInput, kindSelect, recipientInput, removeButton);
    return row;
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
    ocAgentInput.placeholder = 'e.g. frog';
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

    const channelsField = document.createElement('div');
    channelsField.className = 'openclaw-bridge-field';
    const channelsLabel = document.createElement('label');
    channelsLabel.textContent = 'Channels';
    const channelsContainer = document.createElement('div');
    channelsContainer.className = 'openclaw-bridge-channels';
    const addChannelButton = document.createElement('button');
    addChannelButton.type = 'button';
    addChannelButton.className = 'openclaw-bridge-button openclaw-bridge-button--small';
    addChannelButton.textContent = 'Add channel';
    addChannelButton.addEventListener('click', () => {
        channelsContainer.append(renderChannelRow());
        updateChannelWarning();
    });
    const channelsHint = document.createElement('small');
    channelsHint.textContent = 'Each channel: a name, the channel_id (which bot/platform, e.g. discord), a kind (dm = direct-message, channel = post), and the recipient id (your user id for dm, the channel id for channel).';
    const channelWarning = document.createElement('div');
    channelWarning.className = 'openclaw-bridge-channel-warning';
    channelWarning.textContent = "No channels configured — this character can't send proactive messages. Add one below.";
    channelWarning.style.display = 'none';
    channelsField.append(channelsLabel, channelsContainer, addChannelButton, channelsHint, channelWarning);

    // #264: per-character tool allowlist — one checkbox per tool, derived from the shared
    // tool defs so the panel stays in sync. Default-ticked; untick to disable a tool for this
    // character (e.g. write_memory for users who manage memory with their own lorebook).
    const toolsField = document.createElement('div');
    toolsField.className = 'openclaw-bridge-field';
    const toolsLabel = document.createElement('label');
    toolsLabel.textContent = 'Tools';
    const toolsContainer = document.createElement('div');
    toolsContainer.className = 'openclaw-bridge-tools';
    for (const def of [...ACTION_TOOL_DEFS, ...ST_SIDE_TOOL_DEFS]) {
        const row = document.createElement('label');
        row.className = 'openclaw-bridge-tool-row';
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.className = 'openclaw-bridge-tool-toggle';
        toggle.dataset.tool = def.type;
        toggle.checked = true;
        const toggleText = document.createElement('span');
        toggleText.textContent = def.displayName || def.type;
        row.append(toggle, toggleText);
        toolsContainer.append(row);
    }
    const toolsHint = document.createElement('small');
    toolsHint.textContent = 'Untick a tool to stop this character from using it (e.g. disable Write Memory if you manage memory with your own lorebook).';
    toolsField.append(toolsLabel, toolsContainer, toolsHint);

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

    body.append(agentField, ownerField, channelsField, toolsField, actions, authNote, status);
    root.append(header, body);
    container.append(root);

    STATE.managementRoot = root;
    STATE.managementStatus = status;
    STATE.managementFields = {
        toggleInput,
        ocAgentInput,
        ownerIdsInput,
        channelsContainer,
        channelWarning,
        toolsContainer,
        saveButton,
        testButton,
    };

    toggleInput.addEventListener('change', () => {
        updateChannelWarning();
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

// #264: per-character tool allowlist. Default-ON: a checkbox is ticked unless the link
// explicitly disabled that tool. Mirrors the server-side isToolEnabled semantics.
function toolEnabledForUi(link, type) {
    return !(link && link.tools && link.tools[type] === false);
}

// Read the panel's tool checkboxes into a flat { type: boolean } map for the save body.
function collectToolToggles(toggleEls) {
    const tools = {};
    for (const el of toggleEls) {
        const type = el && el.dataset && el.dataset.tool;
        if (type) tools[type] = Boolean(el.checked);
    }
    return tools;
}

// Apply a link's allowlist to the panel checkboxes (all ticked when link is null/unset).
function applyToolTogglesToPanel(container, link) {
    if (!container) return;
    for (const el of container.querySelectorAll('.openclaw-bridge-tool-toggle')) {
        el.checked = toolEnabledForUi(link, el.dataset.tool);
    }
}

async function loadLinkState(characterName) {
    if (!characterName) {
        setManagementStatus('Enter a character name to configure.', 'muted');
        return;
    }

    setManagementLoading(true);
    try {
        const response = await fetch(
            `/api/plugins/openclaw-bridge/characters/${encodeURIComponent(characterName)}/link`,
            { method: 'GET', headers: buildPluginHeaders({ omitContentType: true }) },
        );

        const fields = STATE.managementFields;
        if (!fields) return;

        if (response.status === 404) {
            fields.ocAgentInput.value = '';
            fields.ownerIdsInput.value = '';
            fields.toggleInput.checked = false;
            fields.channelsContainer.replaceChildren();
            applyToolTogglesToPanel(fields.toolsContainer, null);
            setManagementStatus('Not linked yet.', 'muted');
            return;
        }

        if (!response.ok) {
            const text = await response.text();
            throw new Error(text || `Failed to load link state (${response.status})`);
        }

        const { link } = await response.json();

        if (link) {
            fields.ocAgentInput.value = link.oc_agent_id || '';
            fields.ownerIdsInput.value = Array.isArray(link.owner_user_ids)
                ? link.owner_user_ids.join(', ')
                : '';
            fields.toggleInput.checked = Boolean(link.active);
            fields.channelsContainer.replaceChildren(
                ...( Array.isArray(link.channels) ? link.channels : [] ).map(renderChannelRow)
            );
            applyToolTogglesToPanel(fields.toolsContainer, link);
            setManagementStatus(`Linked as ${link.oc_agent_id || 'unknown'}.`, 'success');
        } else {
            fields.ocAgentInput.value = '';
            fields.ownerIdsInput.value = '';
            fields.toggleInput.checked = false;
            fields.channelsContainer.replaceChildren();
            applyToolTogglesToPanel(fields.toolsContainer, null);
            setManagementStatus('Not linked yet.', 'muted');
        }
    } catch (error) {
        setManagementStatus(error?.message || 'Failed to load link state.', 'error');
    } finally {
        setManagementLoading(false);
        updateChannelWarning();
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

    const channels = [];
    for (const row of fields.channelsContainer.querySelectorAll('.openclaw-bridge-channel-row')) {
        const name = row.querySelector('.openclaw-bridge-channel-name')?.value.trim() || '';
        const channelId = row.querySelector('.openclaw-bridge-channel-id')?.value.trim() || '';
        const kind = row.querySelector('.openclaw-bridge-channel-kind')?.value.trim() || '';
        const id = row.querySelector('.openclaw-bridge-channel-recipient')?.value.trim() || '';
        // #250: name + channel_id (adapter) + kind (dm|channel) + recipient id are all required.
        if (!name || !channelId || (kind !== 'dm' && kind !== 'channel') || !id) {
            setManagementStatus('Each channel needs a name, channel ID, kind (dm or channel), and recipient id.', 'error');
            return;
        }
        channels.push({ name, channel_id: channelId, kind, id });
    }

    const tools = collectToolToggles(
        Array.from(fields.toolsContainer ? fields.toolsContainer.querySelectorAll('.openclaw-bridge-tool-toggle') : []),
    );

    setManagementLoading(true);
    try {
        const response = await fetch(`/api/plugins/openclaw-bridge/characters/${encodeURIComponent(characterName)}/link`, {
            method: 'POST',
            headers: { ...buildPluginHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                oc_agent_id: ocAgentId,
                owner_user_ids: ownerIds,
                active: Boolean(fields.toggleInput.checked),
                channels,
                tools,
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
    STATE.characterLocks.set(characterName, next.catch((err) => {
        console.error('[openclaw-bridge] Character lock task threw:', err);
    }));
    return next;
}

function withGenerationLock(task, timeoutMs) {
    let wrappedTask = task;
    if (timeoutMs) {
        wrappedTask = (...args) => {
            let timeoutHandle;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutHandle = setTimeout(
                    () => reject(new Error(`[openclaw-bridge] generateForCharacter timed out after ${timeoutMs}ms`)),
                    timeoutMs
                );
            });
            return Promise.race([task(...args), timeoutPromise])
                .finally(() => clearTimeout(timeoutHandle));
        };
    }
    const next = STATE.generationLock.then(wrappedTask, wrappedTask);
    STATE.generationLock = next.catch((err) => {
        console.error('[openclaw-bridge] Generation lock task threw:', err);
    });
    return next;
}

function queueCharacterAction(actionType, params) {
    const ctx = getStContext();
    const charIdx = typeof ctx.characterId === 'number' ? ctx.characterId : -1;
    const characterName = charIdx >= 0 ? ctx.characters?.[charIdx]?.name : null;

    if (!characterName) {
        console.warn('[openclaw-bridge] Tool called but no active character in context');
        return JSON.stringify({ success: false, error: 'No active character' });
    }

    const pending = STATE.pendingActions.get(characterName);
    if (!pending) {
        console.warn('[openclaw-bridge] Tool called outside of an active generation for:', characterName);
        return JSON.stringify({ success: false, error: 'No active generation context' });
    }

    pending.push({ type: actionType, ...params });
    console.info('[openclaw-bridge] Queued character action:', actionType, 'for', characterName);
    return JSON.stringify({ success: true, message: `Action queued: ${actionType}` });
}

function queueStSideAction(actionType, params) {
    const ctx = getStContext();
    const charIdx = typeof ctx.characterId === 'number' ? ctx.characterId : -1;
    const characterName = charIdx >= 0 ? ctx.characters?.[charIdx]?.name : null;

    if (!characterName) {
        console.warn('[openclaw-bridge] st_side tool called but no active character');
        return JSON.stringify({ success: false, error: 'No active character' });
    }

    const pending = STATE.pendingStSideActions.get(characterName);
    if (!pending) {
        console.warn('[openclaw-bridge] st_side tool called outside active generation for:', characterName);
        return JSON.stringify({ success: false, error: 'No active generation context' });
    }

    pending.push({ type: actionType, ...params });
    console.info('[openclaw-bridge] Queued st_side action:', actionType, 'for', characterName);
    return JSON.stringify({ success: true, message: `Memory queued: ${actionType}` });
}

function registerBridgeTools() {
    const context = getStContext();
    if (typeof context?.registerFunctionTool !== 'function') {
        console.warn('[openclaw-bridge] registerFunctionTool not available in ST context — skipping tool registration');
        return;
    }

    function toStParams(def) {
        return {
            type: 'object',
            properties: Object.fromEntries(def.parameters.map(p => [p.name, { type: p.type, description: p.description }])),
            required: def.parameters.filter(p => p.required).map(p => p.name),
        };
    }

    for (const def of ACTION_TOOL_DEFS) {
        context.registerFunctionTool({
            name: `openclaw_${def.type}`,
            displayName: def.displayName,
            description: def.description,
            parameters: toStParams(def),
            stealth: true,
            action: async (params) => queueCharacterAction(def.type, params),
        });
    }

    for (const def of ST_SIDE_TOOL_DEFS) {
        context.registerFunctionTool({
            name: `openclaw_${def.type}`,
            displayName: def.displayName,
            description: def.description,
            parameters: toStParams(def),
            stealth: true,
            action: async (params) => queueStSideAction(def.type, params),
        });
    }

    const allRegistered = [
        ...ACTION_TOOL_DEFS.map(d => `openclaw_${d.type}`),
        ...ST_SIDE_TOOL_DEFS.map(d => `openclaw_${d.type}`),
    ];
    console.info('[openclaw-bridge] Registered bridge function tools:', allRegistered);
}

async function generateForCharacter(characterName, message, pluginTimeoutMs) {
    // Fire slightly before the plugin's own timeout so we can send a generate_error
    // back before the plugin side times out waiting for a response.
    const timeoutMs = pluginTimeoutMs ? Math.max(pluginTimeoutMs - 30000, 10000) : 840000;
    return withGenerationLock(async () => {
    const context = getStContext();
    let { generate, generateQuietPrompt, sendGenerationRequest, selectCharacterById } = context;

    console.info('[openclaw-bridge] generateForCharacter called with:', { characterName, messageLength: message?.length });
    console.info('[openclaw-bridge] Context functions available:', {
        hasGenerate: typeof generate === 'function',
        hasGenerateQuietPrompt: typeof generateQuietPrompt === 'function',
        hasSendGenerationRequest: typeof sendGenerationRequest === 'function',
        hasSelectCharacterById: typeof selectCharacterById === 'function',
        hasContext: !!context,
        contextKeys: context ? Object.keys(context).slice(0, 20) : 'NO CONTEXT'
    });

    // ST loads characters asynchronously after page render. Poll until the list
    // is non-empty before searching, so the first request after headless startup
    // doesn't fail with "Character not found" due to a timing race.
    const chid = await (async () => {
        const deadline = Date.now() + 30000;
        let firstSeen = false;
        while (Date.now() < deadline) {
            const chars = getCharacters();
            if (chars.length > 0) {
                if (!firstSeen) {
                    firstSeen = true;
                    console.info('[openclaw-bridge] character list loaded, count:', chars.length,
                        'first:', JSON.stringify({ name: chars[0]?.name, avatar: chars[0]?.avatar }));
                }
                const idx = chars.findIndex(c => c?.name === characterName);
                if (idx !== -1) return idx;
            }
            await new Promise(r => setTimeout(r, 500));
        }
        return -1;
    })();

    if (chid === -1) {
        const available = getCharacters().map(c => c?.name).filter(Boolean);
        throw new Error(`Character not found: ${characterName}. Available: ${JSON.stringify(available)}`);
    }

    const previousChid = getCurrentCharacterIndex(context);
    const needsCharacterSwitch = previousChid !== chid;
    const isHeadless = globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE === 'headless';

    // Always log switch decision — this is sent via WS so visible in ST server logs
    sendSocketMessage({ type: 'debug_log', level: 'info', event: 'char_switch_decision',
        characterName, chid, previousChid, needsCharacterSwitch, isHeadless,
        hasSelectCharacterById: typeof selectCharacterById === 'function',
        hasExecuteSlash: typeof context?.executeSlashCommandsWithOptions === 'function',
    });

    if (isHeadless) {
        // Reload chat from disk before generating, so the model never works from a stale
        // in-memory history. The plugin appends new messages to the JSONL after each
        // generation returns; the headless browser only picks them up if we reload first.
        //
        // selectCharacterById() reloads via getChat() ONLY on a real character switch.
        // When the target character is already selected — every heartbeat, every
        // consecutive same-character reply — ST short-circuits and skips getChat()
        // entirely, leaving context.chat frozen at the last switch (#254; the #30 fix
        // wrongly assumed selectCharacterById always reloads). So we force an explicit
        // reloadCurrentChat() below for the no-switch case.
        if (needsCharacterSwitch) {
            console.info('[openclaw-bridge] Headless: switching active character before generation', { from: previousChid, to: chid, characterName });
        } else {
            console.info('[openclaw-bridge] Headless: reloading chat from disk before generation', { chid, characterName });
        }

        // Primary: selectCharacterById (awaits getChat internally on a switch, sets name2 on completion)
        if (typeof selectCharacterById === 'function') {
            try {
                await selectCharacterById(chid);
            } catch (switchErr) {
                sendSocketMessage({ type: 'debug_log', level: 'error', event: 'char_switch_error',
                    method: 'selectCharacterById', error: switchErr?.message });
            }
        }

        // selectCharacterById() above no-ops its getChat() reload when the character is
        // already selected, so force a real disk reload to pull in any messages the plugin
        // appended since the last switch. Gate on !needsCharacterSwitch to avoid a redundant
        // double-reload on the switch path (selectCharacterById already loaded fresh there).
        // This runs inside withGenerationLock, so the clear+rebuild of context.chat cannot
        // race a concurrent generation for this character.
        if (!needsCharacterSwitch) {
            const reloadFn = context?.reloadCurrentChat
                || (typeof reloadCurrentChat === 'function' ? reloadCurrentChat : null);
            if (typeof reloadFn === 'function') {
                try {
                    await reloadFn();
                    console.info('[openclaw-bridge] Headless: reloadCurrentChat completed before generation', { chid, characterName });
                } catch (reloadErr) {
                    sendSocketMessage({ type: 'debug_log', level: 'error', event: 'pre_generation_reload_error',
                        error: reloadErr?.message });
                }
            } else {
                sendSocketMessage({ type: 'debug_log', level: 'warn', event: 'pre_generation_reload_unavailable',
                    note: 'reloadCurrentChat unavailable — generation may use stale history' });
            }
        }

        // Verify the reload/switch worked by reading a fresh context snapshot
        await new Promise(r => setTimeout(r, 300)); // let any async side-effects settle
        const postSwitchCtx = getStContext();
        const postSwitchChid = Number(postSwitchCtx?.characterId);
        const postSwitchName2 = postSwitchCtx?.name2;

        sendSocketMessage({ type: 'debug_log', level: 'info', event: 'char_switch_after_primary',
            postSwitchChid, postSwitchName2, targetChid: chid, targetName: characterName,
            switchOk: postSwitchChid === chid });

        // Fallback: /go command if primary reload/switch failed
        if (postSwitchChid !== chid && typeof context?.executeSlashCommandsWithOptions === 'function') {
            console.info('[openclaw-bridge] Headless: primary switch failed, trying /go command');
            try {
                await context.executeSlashCommandsWithOptions(`/go ${characterName}`);
                await new Promise(r => setTimeout(r, 500));
                const fallbackCtx = getStContext();
                sendSocketMessage({ type: 'debug_log', level: 'info', event: 'char_switch_after_fallback',
                    characterId: Number(fallbackCtx?.characterId), name2: fallbackCtx?.name2, targetChid: chid });
            } catch (fallbackErr) {
                sendSocketMessage({ type: 'debug_log', level: 'error', event: 'char_switch_fallback_error',
                    error: fallbackErr?.message });
            }
        }
    } else if (needsCharacterSwitch) {
        sendSocketMessage({ type: 'debug_log', level: 'info', event: 'char_switch_skipped',
            reason: 'not headless', chid, characterName, previousChid });
    }

    let result;

    // Log the ST state right before generation so we can verify the character context
    const preGenCtx = getStContext();
    sendSocketMessage({ type: 'debug_log', level: 'info', event: 'pre_generation_state',
        characterId: Number(preGenCtx?.characterId), name2: preGenCtx?.name2,
        chatId: preGenCtx?.chatId, targetChid: chid, targetName: characterName });

    console.info('[openclaw-bridge] Attempting generation with message:', { characterName, messagePreview: message?.substring(0, 100) });

    let debugMethod = null;
    let debugLog = [];

    // Temporarily override the displayed character name (name2) so ST's prompt assembly uses the correct persona
    const previousName2 = (typeof name2 !== 'undefined') ? name2 : undefined;
    let nameOverridden = false;
    try {
        if (typeof setCharacterName === 'function') {
            try {
                setCharacterName(characterName);
                nameOverridden = true;
                debugLog.push(`setCharacterName -> ${characterName}`);
                console.info('[openclaw-bridge] Temporarily set name2 for generation to:', characterName);
            } catch (e) {
                console.warn('[openclaw-bridge] setCharacterName failed:', e);
                debugLog.push(`setCharacterName failed: ${e.message}`);
            }
        } else if (typeof globalThis.setCharacterName === 'function') {
            try {
                globalThis.setCharacterName(characterName);
                nameOverridden = true;
                debugLog.push(`global setCharacterName -> ${characterName}`);
            } catch (e) {
                console.warn('[openclaw-bridge] global setCharacterName failed:', e);
                debugLog.push(`global setCharacterName failed: ${e.message}`);
            }
        } else {
            debugLog.push('setCharacterName not available; forceChId handles character targeting');
        }

        if (typeof generateQuietPrompt === 'function') {
            debugMethod = 'context.generateQuietPrompt';
            console.info('[openclaw-bridge] Using context.generateQuietPrompt()');
            debugLog.push('Using context.generateQuietPrompt()');
            result = await generateQuietPrompt({
                quietPrompt: message,
                forceChId: chid,
                skipWIAN: false,
                quietToLoud: true,
                removeReasoning: false,
                trimToSentence: false,
            });
            debugLog.push(`generateQuietPrompt returned: ${typeof result} (${result?.length || 0} chars)`);

            // If generateQuietPrompt returned empty, fall through to generate() as a safety net
            if (!result && typeof generate === 'function') {
                console.warn('[openclaw-bridge] generateQuietPrompt returned empty; falling back to generate()');
                debugLog.push('generateQuietPrompt was empty; falling back to generate()');
                result = await generate('quiet', {
                    quiet_prompt: message,
                    force_chid: chid,
                    force_name2: true,
                    skipWIAN: false,
                    quietToLoud: true,
                });
                debugLog.push(`generate() fallback returned: ${typeof result} (${result?.length || 0} chars)`);
            }
        } else if (typeof generate === 'function') {
            debugMethod = 'context.generate';
            console.info('[openclaw-bridge] Using context.generate()');
            debugLog.push('Using context.generate()');
            try {
                console.info('[openclaw-bridge] Calling generate with params:', { quiet_prompt: message.substring(0, 50), force_chid: chid, force_name2: true, quietToLoud: true });
                result = await generate('quiet', {
                    quiet_prompt: message,
                    force_chid: chid,
                    force_name2: true,
                    skipWIAN: false,
                    quietToLoud: true,
                });
                console.info('[openclaw-bridge] generate() returned:', { type: typeof result, length: result?.length, preview: typeof result === 'string' ? result.substring(0, 100) : result });
                debugLog.push(`generate() returned ${typeof result}: ${result?.substring?.(0, 100) || JSON.stringify(result)}`);
            } catch (genErr) {
                console.error('[openclaw-bridge] generate() threw error:', genErr);
                debugLog.push(`generate() ERROR: ${genErr.message}`);
                throw genErr;
            }
        } else if (typeof context?.Generate === 'function') {
            debugMethod = 'context.Generate';
            console.info('[openclaw-bridge] Using context.Generate()');
            debugLog.push('Using context.Generate()');
            result = await context.Generate('quiet', {
                quiet_prompt: message,
                force_chid: chid,
                force_name2: true,
                skipWIAN: false,
                quietToLoud: true,
            });
            debugLog.push(`context.Generate returned: ${typeof result} (${result?.length || 0} chars)`);
        } else if (typeof Generate === 'function') {
            debugMethod = 'global.Generate';
            console.info('[openclaw-bridge] Using global Generate()');
            debugLog.push('Using global Generate()');
            result = await Generate('quiet', {
                quiet_prompt: message,
                force_chid: chid,
                force_name2: true,
                skipWIAN: false,
                quietToLoud: true,
            });
            debugLog.push(`Generate returned: ${typeof result} (${result?.length || 0} chars)`);
        } else if (typeof sendGenerationRequest === 'function') {
            debugMethod = 'context.sendGenerationRequest';
            console.info('[openclaw-bridge] Using context.sendGenerationRequest()');
            debugLog.push('Using context.sendGenerationRequest()');
            result = await sendGenerationRequest('quiet', {
                prompt: message,
                force_chid: chid,
                quiet_prompt: message,
                stream: false,
            }, { removeReasoning: false, trimToSentence: false, quietToLoud: true });
            if (result && typeof result === 'object' && 'text' in result && typeof result.text === 'string') {
                result = result.text;
            }
            debugLog.push(`sendGenerationRequest returned: ${typeof result} (${result?.length || 0} chars)`);
        } else {
            // In some environments (tests or timing races) the SillyTavern context APIs
            // may not be immediately available. Poll briefly before failing so
            // transient race conditions don't cause a hard error.
            debugLog.push('No Generate API found; polling briefly for availability');
            const pollDeadline = Date.now() + 2000; // 2s
            let foundApi = false;
            while (Date.now() < pollDeadline) {
                const ctx = getStContext();
                if (ctx && (typeof ctx.generate === 'function' || typeof ctx.generateQuietPrompt === 'function' || typeof ctx.sendGenerationRequest === 'function' || typeof ctx.Generate === 'function')) {
                    foundApi = true;
                    debugLog.push('Generate API became available during poll');
                    break;
                }
                // small sleep
                // eslint-disable-next-line no-await-in-loop
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            if (!foundApi) {
                debugLog.push('ERROR: No Generate API available in the SillyTavern context after polling');
                throw new Error('No Generate API available in the SillyTavern context');
            }

            // Refresh local references to context functions in case they were added after initial load
            try {
                const refreshed = getStContext();
                ({ generate, generateQuietPrompt, sendGenerationRequest, selectCharacterById } = refreshed || {});
                debugLog.push('Refreshed context function references after poll');
            } catch (e) {
                debugLog.push('Failed to refresh context functions after poll: ' + (e?.message || String(e)));
            }
        }
    } finally {
        // Restore previous displayed name
        if (nameOverridden && typeof setCharacterName === 'function') {
            if (typeof previousName2 === 'string') {
                try {
                    setCharacterName(previousName2);
                    debugLog.push(`restored name2 -> ${previousName2}`);
                    console.info('[openclaw-bridge] Restored original name2 after generation');
                } catch (e) {
                    console.warn('[openclaw-bridge] Failed to restore name2:', e);
                    debugLog.push(`restore name2 failed: ${e.message}`);
                }
            }
        }
    }

    // Send debug log to server for inspection
    sendSocketMessage({
        type: 'debug_log',
        level: 'info',
        event: 'generation_debug',
        method: debugMethod,
        logs: debugLog,
        resultType: typeof result,
        resultLength: result?.length || 0
    });

    // send debug info back to plugin/ws server so it can be logged on server side
    try {
        sendSocketMessage({ type: 'debug_log', level: 'info', event: 'generation_method', method: debugMethod, rawType: typeof result, preview: (typeof result === 'string' ? result.substring(0, 200) : undefined) });
    } catch (e) {
        console.warn('[openclaw-bridge] Failed to send debug_log over socket', e);
    }

    console.info('[openclaw-bridge] Generation result (raw):', { type: typeof result, length: result?.length, preview: typeof result === 'string' ? result.substring(0, 100) : result });


    const normalized = stripInstructTemplate(normalizeGenerationResult(result));
    console.info('[openclaw-bridge] Final normalized result:', { length: normalized?.length, preview: normalized?.substring(0, 100) });
    return normalized;
    }, timeoutMs); // end withGenerationLock
}

async function handleGenerateRequest(payload) {
    const { requestId, character, message, timeout_ms } = payload;
    console.info('[openclaw-bridge] handleGenerateRequest received:', { requestId, character, messagePreview: message?.substring(0, 50) });

    try {
        console.info('[openclaw-bridge] Starting generation with character lock');
        const response = await withCharacterLock(character, () => {
            STATE.pendingActions.set(character, []);
            STATE.pendingStSideActions.set(character, []);
            return generateForCharacter(character, message, timeout_ms);
        });
        const actions = STATE.pendingActions.get(character) || [];
        const stSideActions = STATE.pendingStSideActions.get(character) || [];
        console.info('[openclaw-bridge] Generation completed:', { requestId, responseLength: response?.length, actionsCount: actions.length, stSideActionsCount: stSideActions.length, responsePreview: response?.substring(0, 100) });
        if (response == null) {
            sendSocketMessage({ type: 'generate_error', requestId, error: 'Generation returned null/undefined — check LLM model/connection' });
            return;
        }
        sendSocketMessage({
            type: 'generate_response',
            requestId,
            response,
            actions,
            st_side_actions: stSideActions,
        });
    } catch (error) {
        console.error('[openclaw-bridge] Generation failed:', { requestId, error: error?.message || String(error), stack: error?.stack });
        sendSocketMessage({
            type: 'generate_error',
            requestId,
            error: error?.message || String(error),
        });
    } finally {
        STATE.pendingActions.delete(character);
        STATE.pendingStSideActions.delete(character);
    }
}

function sendSocketMessage(payload) {
    if (!STATE.socket || STATE.socket.readyState !== WebSocket.OPEN) {
        return;
    }

    try {
        STATE.socket.send(JSON.stringify(payload));
    } catch (err) {
        console.error('[openclaw-bridge] Socket send failed:', err.message);
        try { STATE.socket.close(); } catch (_) {}
    }
}

function startHttpPollingFallback() {
    if (STATE.pollingInterval) return;
    console.info('[openclaw-bridge] Starting HTTP polling fallback for plugin messages');
    let poll404Count = 0;
    STATE.pollingInterval = setInterval(async () => {
        try {
            const headers = buildPluginHeaders({ omitContentType: true }) || {};
            const clientType = globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE || 'ui';
            const resp = await fetch(`/api/plugins/openclaw-bridge/http-message?clientType=${clientType}`, {
                method: 'GET',
                credentials: 'same-origin',
                headers,
            });

            if (resp.status === 204) return;

            if (resp.status === 404) {
                poll404Count += 1;
                if (poll404Count === 1) console.warn('[openclaw-bridge] HTTP polling returned 404; plugin route may be missing');
                return;
            }

            if (!resp.ok) {
                console.warn('[openclaw-bridge] HTTP polling returned:', resp.status);
                return;
            }

            poll404Count = 0;
            const msg = await resp.json();
            console.info('[openclaw-bridge] Polled HTTP message:', msg.type, msg.requestId);
            if (msg.type === 'generate') {
                const payload = msg.payload || {};
                let responseText;
                let actions = [];
                let stSideActions = [];
                try {
                    responseText = await withCharacterLock(payload.character, () => {
                        STATE.pendingActions.set(payload.character, []);
                        STATE.pendingStSideActions.set(payload.character, []);
                        return generateForCharacter(payload.character, payload.message, msg.timeout_ms);
                    });
                    actions = STATE.pendingActions.get(payload.character) || [];
                    stSideActions = STATE.pendingStSideActions.get(payload.character) || [];
                } finally {
                    STATE.pendingActions.delete(payload.character);
                    STATE.pendingStSideActions.delete(payload.character);
                }
                const responseBody = JSON.stringify({ type: 'generate_response', requestId: msg.requestId, response: responseText, actions, st_side_actions: stSideActions });
                let postResp = await fetch('/api/plugins/openclaw-bridge/http-response', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: Object.assign({ 'Content-Type': 'application/json' }, buildPluginHeaders()),
                    body: responseBody,
                });
                if (postResp.status === 403) {
                    // CSRF token expired (ST may have restarted) — refresh and retry once.
                    STATE.csrfToken = null;
                    await fetchCsrfToken();
                    postResp = await fetch('/api/plugins/openclaw-bridge/http-response', {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: Object.assign({ 'Content-Type': 'application/json' }, buildPluginHeaders()),
                        body: responseBody,
                    });
                    if (!postResp.ok) {
                        console.warn('[openclaw-bridge] HTTP response POST retry failed:', postResp.status);
                    }
                }
            } else if (msg.type === 'chat_updated') {
                if (!STATE.connected) {
                    console.info('[openclaw-bridge] chat_updated received via HTTP poll:', { character: msg.character });
                    await handleChatUpdatedMessage(msg);
                }
            } else if (msg.type === 'config_warning') {
                console.info('[openclaw-bridge] config_warning received via HTTP poll:', { character: msg.character });
                handleConfigWarning(msg);
            }
        } catch (e) {
            console.warn('[openclaw-bridge] HTTP polling error:', e);
        }
    }, 2000);
}

function stopHttpPollingFallback() {
    if (!STATE.pollingInterval) return;
    clearInterval(STATE.pollingInterval);
    STATE.pollingInterval = null;
    console.info('[openclaw-bridge] Stopped HTTP polling fallback');
}

// Decide how the UI should react to a chat_updated event (#235). Pure (no browser
// globals) so it can be unit-tested in isolation. Returns one of:
//   'skip'      — not viewing the updated character; do nothing
//   'duplicate' — this exact update is already on screen; do nothing
//   'badge'     — user scrolled up; show the "new message" badge (existing behavior)
//   'append'    — at the bottom and safe to append incrementally (no full re-render)
//   'reload'    — at the bottom but can't append safely; fall back to a full reload
// Note: a full reload reloads from disk (ground truth), so 'reload' is always the safe
// fallback — we never risk a divergent view, only a momentary flash.
function decideChatUpdate({ updatedChid, currentChid, atBottom, canAppend, alreadyApplied }) {
    if (updatedChid === -1 || currentChid !== updatedChid) return 'skip';
    if (alreadyApplied) return 'duplicate';
    if (!atBottom) return 'badge';
    return canAppend ? 'append' : 'reload';
}

// True when payload.appended can be rendered incrementally via ST's addOneMessage
// without a full reload. Conservative: any missing piece falls back to reload.
function canAppendIncrementally(payload, context) {
    return Array.isArray(payload?.appended)
        && payload.appended.length > 0
        && Array.isArray(context?.chat)
        && typeof context?.addOneMessage === 'function';
}

// True when the last appended entry's exchange_id already matches the tail of the
// in-memory chat — i.e. this update was already applied (re-delivery guard). Entries
// without an exchange_id (e.g. heartbeat log lines) are not deduped this way; the
// timestamp guard in handleChatUpdatedMessage still covers exact duplicates.
function isUpdateAlreadyApplied(payload, context) {
    const appended = payload?.appended;
    const chat = context?.chat;
    if (!Array.isArray(appended) || appended.length === 0) return false;
    if (!Array.isArray(chat) || chat.length === 0) return false;
    const lastAppendedId = appended[appended.length - 1]?.exchange_id;
    if (!lastAppendedId) return false;
    return chat[chat.length - 1]?.exchange_id === lastAppendedId;
}

// Append the written entries straight into ST's chat without a full re-render.
// The plugin already persisted these to disk, so we only update the in-memory chat
// array and the DOM — never write back (that would double-write history).
async function appendMessagesIncrementally(appended, context) {
    for (const entry of appended) {
        context.chat.push(entry);
        await context.addOneMessage(entry, { scroll: true });
    }
}

// #234: surface a send_message misconfig as a transient toast so the user gets a clue that
// something isn't configured, without it being persisted to chat history. Headless has no UI.
function handleConfigWarning(payload) {
    if (globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE === 'headless') return;
    const message = payload && payload.message;
    if (!message) return;
    if (globalThis.toastr && typeof globalThis.toastr.warning === 'function') {
        globalThis.toastr.warning(message, 'OpenClaw Bridge');
    }
}

async function handleChatUpdatedMessage(payload) {
    if (globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE === 'headless') return;
    // Deduplicate: two active WS sockets both receive the same broadcast.
    // The timestamp is set once per generation, so identical timestamps = same event.
    if (payload.timestamp && payload.timestamp === STATE.lastChatUpdatedTs) {
        console.info('[openclaw-bridge] chat_updated duplicate ignored:', payload.character);
        return;
    }
    if (payload.timestamp) STATE.lastChatUpdatedTs = payload.timestamp;
    try {
        const context = getStContext();
        const updatedChid = findCharacterIndex(payload.character);
        const currentChid = typeof context?.characterId === 'number'
            ? context.characterId
            : getCurrentCharacterIndex(context);
        const reloadFn = context?.reloadCurrentChat || (typeof reloadCurrentChat === 'function' ? reloadCurrentChat : null);
        const atBottom = isAtChatBottom();
        const canAppend = canAppendIncrementally(payload, context);
        const alreadyApplied = isUpdateAlreadyApplied(payload, context);

        const action = decideChatUpdate({ updatedChid, currentChid, atBottom, canAppend, alreadyApplied });

        console.info('[openclaw-bridge] chat_updated check:', {
            action,
            updatedChid,
            currentChid,
            contextCharacterId: context?.characterId,
            hasReloadFn: typeof reloadFn === 'function',
            atBottom,
            canAppend,
            alreadyApplied,
            appendedCount: Array.isArray(payload?.appended) ? payload.appended.length : 0,
        });

        switch (action) {
            case 'skip':
                console.info('[openclaw-bridge] Not viewing updated character; skipping reload');
                return;
            case 'duplicate':
                console.info('[openclaw-bridge] chat_updated already applied; skipping');
                return;
            case 'append':
                hideNewMessageBadge();
                try {
                    await appendMessagesIncrementally(payload.appended, context);
                    console.info('[openclaw-bridge] chat_updated appended incrementally:', payload.appended.length);
                } catch (appendErr) {
                    // Append failed partway — reload from disk (ground truth) to recover.
                    // reloadCurrentChat clears and rebuilds from the JSONL, so any partial
                    // in-memory push is discarded; we never persist a divergent state.
                    console.warn('[openclaw-bridge] incremental append failed; falling back to reload:', appendErr);
                    if (typeof reloadFn === 'function') await reloadFn();
                }
                return;
            case 'badge':
                if (typeof reloadFn !== 'function') {
                    console.warn('[openclaw-bridge] reloadCurrentChat() unavailable; cannot show new-message badge');
                    return;
                }
                console.info('[openclaw-bridge] Scrolled up; showing new message badge');
                showNewMessageBadge(payload.character, reloadFn);
                return;
            case 'reload':
            default:
                if (typeof reloadFn !== 'function') {
                    console.warn('[openclaw-bridge] reloadCurrentChat() is not available in this context');
                    return;
                }
                console.info('[openclaw-bridge] At chat bottom; reloading');
                hideNewMessageBadge();
                await reloadFn();
                console.info('[openclaw-bridge] reloadCurrentChat completed');
                return;
        }
    } catch (e) {
        console.warn('[openclaw-bridge] Error handling chat_updated:', e);
    }
}

function isAtChatBottom() {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return true;
    return chatEl.scrollHeight - chatEl.scrollTop <= chatEl.clientHeight + 60;
}

function showNewMessageBadge(characterName, reloadFn) {
    hideNewMessageBadge(); // remove any existing badge first

    const chat = document.getElementById('chat');
    if (!chat) {
        console.warn('[openclaw-bridge] #chat not found; cannot show new message badge');
        return;
    }

    // Sticky-bottom inside #chat: immune to ancestor CSS transforms that break position:fixed.
    // Appended at end-of-list → sticks to the bottom of the visible chat area when scrolled up.
    const wrapper = document.createElement('div');
    wrapper.id = 'openclaw-bridge-new-msg-badge';
    wrapper.style.cssText = 'position:sticky;bottom:10px;text-align:center;z-index:100;pointer-events:none;margin:4px 0;';

    const btn = document.createElement('button');
    btn.style.cssText = 'pointer-events:auto;background:#4a9eff;color:#fff;border:none;border-radius:16px;padding:6px 18px;font-size:13px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.35);white-space:nowrap;';
    btn.textContent = `↓ New message from ${characterName}`;
    btn.onclick = async () => {
        hideNewMessageBadge();
        if (typeof reloadFn === 'function') await reloadFn();
    };

    wrapper.appendChild(btn);
    chat.appendChild(wrapper);
    STATE.newMessageBadge = wrapper;
}

function hideNewMessageBadge() {
    if (STATE.newMessageBadge) {
        STATE.newMessageBadge.remove();
        STATE.newMessageBadge = null;
    }
}

async function handleSseMessage(payload) {
    if (payload.type === 'chat_updated') {
        console.info('[openclaw-bridge] chat_updated received via SSE:', { character: payload.character });
        await handleChatUpdatedMessage(payload);
    } else if (payload.type === 'config_warning') {
        console.info('[openclaw-bridge] config_warning received via SSE:', { character: payload.character });
        handleConfigWarning(payload);
    } else if (payload.type === 'notification') {
        addNotification(payload);
    }
}

// SSE-based connection for UI browsers: push events arrive over ST's existing HTTP port,
// so no second port needs to be forwarded in SSH/remote deployments.
// Generation fallback (when headless is unavailable) still uses HTTP polling.
function connectSse() {
    if (STATE.sseAbortController) {
        try { STATE.sseAbortController.abort(); } catch (e) {}
        STATE.sseAbortController = null;
    }

    const myConnectionId = ++STATE.connectionId;

    async function attempt() {
        if (STATE.connectionId !== myConnectionId) return;

        const controller = new AbortController();
        STATE.sseAbortController = controller;

        try {
            const headers = Object.assign(
                { Accept: 'text/event-stream' },
                buildPluginHeaders({ omitContentType: true }) || {}
            );

            const response = await fetch('/api/plugins/openclaw-bridge/events', {
                credentials: 'same-origin',
                headers,
                signal: controller.signal,
            });

            if (!response.ok) {
                throw new Error(`SSE endpoint responded ${response.status}`);
            }

            STATE.connected = true;
            STATE.backoffMs = 1000;
            // HTTP polling runs alongside SSE: handles generate work when headless is unavailable.
            // chat_updated events polled over HTTP are silently dropped while SSE is connected.
            startHttpPollingFallback();
            console.info('[openclaw-bridge] SSE connected');

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const blocks = buffer.split('\n\n');
                buffer = blocks.pop(); // hold incomplete block for next chunk

                for (const block of blocks) {
                    if (!block.trim() || block.startsWith(':')) continue; // skip heartbeat comments
                    const dataLine = block.split('\n').find(l => l.startsWith('data: '));
                    if (!dataLine) continue;
                    try {
                        const payload = JSON.parse(dataLine.slice(6));
                        await handleSseMessage(payload);
                    } catch (e) {
                        console.warn('[openclaw-bridge] SSE parse error:', e);
                    }
                }
            }

            throw new Error('SSE stream ended');
        } catch (e) {
            if (e.name === 'AbortError') return;
            if (STATE.connectionId !== myConnectionId) return;

            STATE.connected = false;
            STATE.sseAbortController = null;
            STATE.backoffMs = Math.min(STATE.backoffMs * 1.5, STATE.maxBackoffMs);
            console.info(`[openclaw-bridge] SSE disconnected (${e.message}), reconnecting in ${STATE.backoffMs}ms`);
            startHttpPollingFallback(); // chat_updated falls back to HTTP poll while SSE is down
            STATE.sseReconnectTimer = setTimeout(attempt, STATE.backoffMs);
        }
    }

    attempt();
}

function connect() {
    console.log('[openclaw-bridge] connect() called, current STATE:', { connected: STATE.connected, hasSocket: !!STATE.socket });

    if (STATE.socket && (STATE.socket.readyState === WebSocket.OPEN || STATE.socket.readyState === WebSocket.CONNECTING)) {
        console.log('[openclaw-bridge] Already connected or connecting, skipping');
        return;
    }

    // Tag this attempt so stale sockets from earlier connect() calls self-close.
    const myConnectionId = ++STATE.connectionId;

    // Derive WebSocket URL from current location with optional global overrides.
    function getWebSocketUrl() {
        console.log('[openclaw-bridge] getWebSocketUrl() called');
        if (globalThis.OPENCLAW_BRIDGE_WS_URL) {
            console.info('[openclaw-bridge] Using override WS URL:', globalThis.OPENCLAW_BRIDGE_WS_URL);
            return globalThis.OPENCLAW_BRIDGE_WS_URL;
        }

        const port = globalThis.OPENCLAW_BRIDGE_WS_PORT || 8765;
        const protocol = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss:' : 'ws:';
        // Use page's own hostname (localhost, 192.168.x, etc.) instead of hardcoded 127.0.0.1
        let host = (typeof location !== 'undefined' && location.hostname) ? location.hostname : 'localhost';

        // Workaround: if hostname is 127.0.0.1, try localhost instead as some browsers block 127.0.0.1 cross-port
        if (host === '127.0.0.1') {
            console.log('[openclaw-bridge] Using localhost instead of 127.0.0.1 to work around browser cross-port restrictions');
            host = 'localhost';
        }

        const url = `${protocol}//${host}:${port}`;
        console.info('[openclaw-bridge] Derived WS URL from page:', { protocol, host, port, url });
        return url;
    }

    try {
        const candidateHosts = [];
        // try current page hostname first, then common localhost variants
        const pageHost = (typeof location !== 'undefined' && location.hostname) ? location.hostname : null;
        if (pageHost) candidateHosts.push(pageHost);
        candidateHosts.push('localhost', '127.0.0.1', '::1');

        // Deduplicate while preserving order
        const hosts = Array.from(new Set(candidateHosts));

        const protocol = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss:' : 'ws:';
        const port = globalThis.OPENCLAW_BRIDGE_WS_PORT || 8765;
        const urls = hosts.map(h => `${protocol}//${h}:${port}`);

        console.log('[openclaw-bridge] Attempting WebSocket URLs:', urls);

        let socket = null;
        let tried = 0;
        let connected = false;

        function attachHandlers(ws) {
            ws.addEventListener('open', () => {
                if (STATE.connectionId !== myConnectionId) {
                    // A newer connect() call is already active — close this stale socket.
                    try { ws.close(); } catch (e) {}
                    return;
                }
                if (connected) return; // ignore late opens within same attempt
                connected = true;
                STATE.socket = ws;
                STATE.connected = true;
                STATE.backoffMs = 1000;
                STATE.pongReceived = true;
                console.info('[openclaw-bridge] ✅ WebSocket connected!');
                stopHttpPollingFallback();
                startHealthCheck();
                // Refresh CSRF token on each connect — ST may have restarted between connects,
                // which would have cleared its session store and invalidated the old token.
                fetchCsrfToken().catch(() => {});
                const clientType = globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE || 'ui';
                const regToken = globalThis.OPENCLAW_BRIDGE_BRIDGE_TOKEN || STATE.bridgeToken || undefined;
                try { ws.send(JSON.stringify({ type: 'register', clientType, token: regToken })); } catch (e) {}
            });

            ws.addEventListener('message', async event => {
                if (STATE.connectionId !== myConnectionId) return; // stale socket
                console.log('[openclaw-bridge] Message received on WebSocket:', String(event.data).substring(0, 200));
                let payload;

                try {
                    payload = JSON.parse(event.data);
                } catch (error) {
                    console.error('[openclaw-bridge] Failed to parse message:', error);
                    return;
                }

                console.log('[openclaw-bridge] Parsed payload type:', payload.type);

                if (payload.type === 'pong') {
                    STATE.pongReceived = true;
                    console.log('[openclaw-bridge] Pong received');
                    return;
                }

                if (payload.type === 'welcome') {
                    if (typeof payload.bridgeToken === 'string' && payload.bridgeToken) {
                        STATE.bridgeToken = payload.bridgeToken;
                    }
                    return;
                }

                if (payload.type === 'generate') {
                    console.info('[openclaw-bridge] ⚡ GENERATE REQUEST RECEIVED:', { character: payload.character, messageLength: payload.message?.length });
                    await handleGenerateRequest(payload);
                    return;
                }

                if (payload.type === 'chat_updated') {
                    console.info('[openclaw-bridge] chat_updated received via WS:', { character: payload.character });
                    await handleChatUpdatedMessage(payload);
                    return;
                }

                if (payload.type === 'config_warning') {
                    console.info('[openclaw-bridge] config_warning received via WS:', { character: payload.character });
                    handleConfigWarning(payload);
                    return;
                }

                if (payload.type === 'notification') {
                    addNotification(payload);
                }
            });

            ws.addEventListener('close', (ev) => {
                if (STATE.connectionId !== myConnectionId) return; // stale socket, ignore
                STATE.connected = false;
                // Refresh CSRF token in the background — don't null it first. The old token
                // stays valid across ST restarts (cookie-session stores state in the cookie,
                // not server-side). Keeping the old value means the HTTP polling POST can
                // succeed immediately without a round-trip 403→refresh→retry cycle.
                fetchCsrfToken().catch(() => {});
                if (STATE.reconnectTimer) {
                    clearTimeout(STATE.reconnectTimer);
                }
                if (STATE.healthCheckInterval) {
                    clearInterval(STATE.healthCheckInterval);
                    STATE.healthCheckInterval = null;
                }

                // Exponential backoff: increase delay each attempt, capped at maxBackoffMs
                STATE.backoffMs = Math.min(STATE.backoffMs * 1.5, STATE.maxBackoffMs);
                console.info(`[openclaw-bridge] WebSocket closed. Reconnecting in ${STATE.backoffMs}ms`);
                startHttpPollingFallback();
                STATE.reconnectTimer = setTimeout(connect, STATE.backoffMs);
            });

            ws.addEventListener('error', (event) => {
                console.error('[openclaw-bridge] WebSocket error event:', event, 'url:', ws.url, 'readyState:', ws.readyState);
                // if not connected yet, try next URL
                if (!connected) {
                    try { ws.close(); } catch (e) {}
                    socket = null;
                    tried += 1;
                    if (tried < urls.length) {
                        console.info('[openclaw-bridge] Trying next WebSocket URL:', urls[tried]);
                        tryConnect();
                    } else {
                        // All attempts failed — close event already scheduled a reconnect;
                        // don't set a second timer or the backoff compounds and two connect()
                        // calls race each other on the next attempt.
                        startHttpPollingFallback();
                    }
                }

                try {
                    sendSocketMessage({
                        type: 'debug_log',
                        level: 'error',
                        event: 'ws_error',
                        message: event?.message || 'unknown WS error',
                        readyState: STATE.socket?.readyState
                    });
                } catch (e) {
                    // ignore
                }
            });
        }

        function tryConnect() {
            const url = urls[tried];
            console.log('[openclaw-bridge] Creating WebSocket to:', url);
            try {
                socket = new WebSocket(url);
                attachHandlers(socket);
            } catch (err) {
                console.error('[openclaw-bridge] Failed to create WebSocket to', url, err);
                tried += 1;
                if (tried < urls.length) {
                    console.info('[openclaw-bridge] Trying next WebSocket URL:', urls[tried]);
                    setTimeout(tryConnect, 200);
                } else {
                    STATE.backoffMs = Math.min(STATE.backoffMs * 1.5, STATE.maxBackoffMs);
                    console.warn('[openclaw-bridge] Unable to create WebSocket to any URL. Falling back to HTTP polling.');
                    // Start HTTP polling fallback
                    startHttpPollingFallback();
                }
            }
        }

        // start first attempt
        tryConnect();

    } catch (err) {
        console.error('[openclaw-bridge] ❌ Unexpected error in connect():', err);
    }
}

function startHealthCheck() {
    // Cancel any existing health check
    if (STATE.healthCheckInterval) {
        clearInterval(STATE.healthCheckInterval);
    }

    // Send ping every 30s; if no pong within 5s, reconnect
    STATE.healthCheckInterval = setInterval(() => {
        if (!STATE.socket || STATE.socket.readyState !== WebSocket.OPEN) {
            clearInterval(STATE.healthCheckInterval);
            STATE.healthCheckInterval = null;
            return;
        }

        STATE.pongReceived = false;
        console.debug('[openclaw-bridge] Health check: sending ping');
        try {
            sendSocketMessage({ type: 'ping' });
        } catch (e) {
            console.warn('[openclaw-bridge] Failed to send health check ping:', e);
        }

        // If no pong received within 5 seconds, reconnect
        setTimeout(() => {
            if (!STATE.pongReceived) {
                console.warn('[openclaw-bridge] Health check failed (no pong); reconnecting');
                if (STATE.socket) STATE.socket.close();
            }
        }, 5000);
    }, 30000);
}

function init() {
    if (typeof window !== 'undefined') {
        if (window.__openclawBridgeLoaded) {
            console.warn('[openclaw-bridge] init() skipped — extension already loaded on this page');
            return;
        }
        window.__openclawBridgeLoaded = true;
    }

    console.log('[openclaw-bridge] ===== INIT CALLED =====');

    try {
        const clientType = globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE || 'ui';
        console.log('[openclaw-bridge] Step 1: Adding small delay before connecting (ST may still be initializing)', { clientType });

        setTimeout(async () => {
            try {
                // Fetch CSRF token before any HTTP POSTs to plugin endpoints.
                // Both headless and UI clients may need to POST via HTTP polling.
                await fetchCsrfToken();

                if (clientType === 'headless') {
                    // Headless Playwright browsers run on the same machine as ST, so the dedicated
                    // WS port (8765) is always reachable without any port forwarding.
                    console.log('[openclaw-bridge] Step 2: Headless client — attempting WebSocket connection');
                    connect();
                } else {
                    // UI browsers may be on a different machine (SSH, VPN) where only ST's main
                    // HTTP port is forwarded. Use SSE over that port for push events; HTTP polling
                    // handles generation work when headless is unavailable.
                    console.log('[openclaw-bridge] Step 2: UI client — connecting via SSE');
                    connectSse();
                }
                ensureSillyTavernApis();
                registerBridgeTools();
                registerManagementPanelHooks();
                console.log('[openclaw-bridge] Step 3: connection attempt started');
            } catch (e) {
                console.error('[openclaw-bridge] ❌ ERROR in delayed init():', e);
            }
        }, 2000);
    } catch (e) {
        console.error('[openclaw-bridge] ❌ ERROR in init():', e);
    }

    console.log('[openclaw-bridge] ===== INIT DONE =====');
}

export {
    init,
    generateForCharacter,
};

// Expose a test-friendly global so E2E tests can observe state and trigger actions.
// state/connect/sendSocketMessage come from the first-loaded instance (|| guard), so
// openclawBridge.state.connected tracks the real connection. refreshManagementPanel is
// always assigned so it is present even when a second module instance loads (blob import).
if (!globalThis.openclawBridge) {
    globalThis.openclawBridge = { state: STATE, connect, sendSocketMessage };
}
globalThis.openclawBridge.refreshManagementPanel = refreshManagementPanel;
globalThis.openclawBridgeLoadLinkState = loadLinkState;
globalThis.openclawBridgeInit = globalThis.openclawBridgeInit || init;
