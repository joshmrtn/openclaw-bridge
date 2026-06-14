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
    csrfToken: null,           // explicitly fetched CSRF token for HTTP plugin requests
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

    const toolDefs = [
        {
            name: 'openclaw_discord_post',
            displayName: 'Post to Discord',
            description: 'Post a message to a Discord channel on behalf of this character.',
            parameters: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: 'Message content to post.' },
                    channel_id: { type: 'string', description: 'Target Discord channel ID. Defaults to the conversation channel if omitted.' },
                },
                required: ['content'],
            },
            actionType: 'discord_post',
        },
        {
            name: 'openclaw_discord_dm',
            displayName: 'Send Discord DM',
            description: 'Send a direct message to a Discord user on behalf of this character.',
            parameters: {
                type: 'object',
                properties: {
                    user_id: { type: 'string', description: 'Discord user ID to DM.' },
                    content: { type: 'string', description: 'Message content to send.' },
                },
                required: ['user_id', 'content'],
            },
            actionType: 'discord_dm',
        },
        {
            name: 'openclaw_telegram_post',
            displayName: 'Post to Telegram',
            description: 'Post a message to a Telegram chat on behalf of this character.',
            parameters: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: 'Message content to post.' },
                    chat_id: { type: 'string', description: 'Telegram chat ID. Defaults to the conversation chat if omitted.' },
                },
                required: ['content'],
            },
            actionType: 'telegram_post',
        },
        {
            name: 'openclaw_file_write',
            displayName: 'Write File',
            description: "Write content to a file in the character's OC workspace.",
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative file path within the workspace.' },
                    content: { type: 'string', description: 'File content to write.' },
                },
                required: ['path', 'content'],
            },
            actionType: 'file_write',
        },
    ];

    for (const { name, displayName, description, parameters, actionType } of toolDefs) {
        context.registerFunctionTool({
            name,
            displayName,
            description,
            parameters,
            stealth: true,
            action: async (params) => queueCharacterAction(actionType, params),
        });
    }

    // Memory tool — st_side action: executed by ST plugin before response returns to OC (R11)
    context.registerFunctionTool({
        name: 'openclaw_write_memory',
        displayName: 'Write Memory',
        description: "Write or update a persistent memory entry in this character's lorebook. " +
            'Use entry_key="core_facts" for the always-active Tier 1 memory (injected every generation — keep it concise). ' +
            'Use a descriptive key for Tier 2 episode memories that fire on keywords. ' +
            'Updates the existing entry in place; never creates duplicates.',
        parameters: {
            type: 'object',
            properties: {
                entry_key: { type: 'string', description: 'Unique identifier for this memory, e.g. "core_facts" or "conversation_bridge_project".' },
                content: { type: 'string', description: 'The memory content to store. For core_facts: one subject per line with comma-separated facts.' },
                tier: { type: 'number', description: '1 = always injected (no keywords, default), 2 = keyword-triggered. Use 1 for core facts, 2 for episode memories.' },
                keywords: { type: 'string', description: 'Comma-separated trigger keywords for tier 2 entries. Ignored for tier 1.' },
            },
            required: ['entry_key', 'content'],
        },
        stealth: true,
        action: async (params) => queueStSideAction('write_memory', params),
    });

    console.info('[openclaw-bridge] Registered bridge function tools:', toolDefs.map(t => t.name));
}

async function generateForCharacter(characterName, message) {
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
        // Always reload via selectCharacterById in headless mode — even when chid hasn't changed.
        // selectCharacterById calls getChat() internally, loading fresh chat from disk.
        // Without this, ST's in-memory chat goes stale after every exchange: the plugin writes
        // new messages to the JSONL file after generation returns, but the headless browser
        // never sees them unless we explicitly reload before the next request.
        if (needsCharacterSwitch) {
            console.info('[openclaw-bridge] Headless: switching active character before generation', { from: previousChid, to: chid, characterName });
        } else {
            console.info('[openclaw-bridge] Headless: reloading chat from disk before generation', { chid, characterName });
        }

        // Primary: selectCharacterById (awaits getChat internally, sets name2 on completion)
        if (typeof selectCharacterById === 'function') {
            try {
                await selectCharacterById(chid);
            } catch (switchErr) {
                sendSocketMessage({ type: 'debug_log', level: 'error', event: 'char_switch_error',
                    method: 'selectCharacterById', error: switchErr?.message });
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
            debugLog.push('setCharacterName not available; relying on force_chid/force_name2');
        }

        if (typeof generateQuietPrompt === 'function') {
            debugMethod = 'context.generateQuietPrompt';
            console.info('[openclaw-bridge] Using context.generateQuietPrompt()');
            debugLog.push('Using context.generateQuietPrompt()');
            try {
                result = await generateQuietPrompt({
                    quietPrompt: message,
                    forceChId: chid,
                    skipWIAN: false,
                    quietToLoud: true,
                    removeReasoning: false,
                    trimToSentence: false,
                });
                debugLog.push(`generateQuietPrompt returned: ${typeof result} (${result?.length || 0} chars)`);
            } catch (e) {
                console.warn('[openclaw-bridge] generateQuietPrompt failed, retrying without force_chid:', e);
                debugLog.push(`generateQuietPrompt failed: ${e.message}`);
                result = await generateQuietPrompt({ quietPrompt: message, quietToLoud: true, removeReasoning: false });
                debugLog.push(`Retry returned: ${typeof result} (${result?.length || 0} chars)`);
            }

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
}

async function handleGenerateRequest(payload) {
    const { requestId, character, message } = payload;
    console.info('[openclaw-bridge] handleGenerateRequest received:', { requestId, character, messagePreview: message?.substring(0, 50) });

    STATE.pendingActions.set(character, []);
    STATE.pendingStSideActions.set(character, []);

    try {
        console.info('[openclaw-bridge] Starting generation with character lock');
        const response = await withCharacterLock(character, () => generateForCharacter(character, message));
        const actions = STATE.pendingActions.get(character) || [];
        const stSideActions = STATE.pendingStSideActions.get(character) || [];
        console.info('[openclaw-bridge] Generation completed:', { requestId, responseLength: response?.length, actionsCount: actions.length, stSideActionsCount: stSideActions.length, responsePreview: response?.substring(0, 100) });
        if (!response) {
            sendSocketMessage({ type: 'generate_error', requestId, error: 'Generation returned empty response — check LLM model/connection' });
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

    STATE.socket.send(JSON.stringify(payload));
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
                STATE.pendingActions.set(payload.character, []);
                STATE.pendingStSideActions.set(payload.character, []);
                let responseText;
                let actions = [];
                let stSideActions = [];
                try {
                    responseText = await withCharacterLock(payload.character, () => generateForCharacter(payload.character, payload.message));
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

        console.info('[openclaw-bridge] chat_updated check:', {
            updatedChid,
            currentChid,
            contextCharacterId: context?.characterId,
            hasReloadFn: typeof reloadFn === 'function',
            charactersCount: context?.characters?.length,
        });

        if (updatedChid !== -1 && currentChid === updatedChid) {
            if (typeof reloadFn !== 'function') {
                console.warn('[openclaw-bridge] reloadCurrentChat() is not available in this context');
            } else if (isAtChatBottom()) {
                console.info('[openclaw-bridge] At chat bottom; reloading');
                hideNewMessageBadge();
                await reloadFn();
                console.info('[openclaw-bridge] reloadCurrentChat completed');
            } else {
                console.info('[openclaw-bridge] Scrolled up; showing new message badge');
                showNewMessageBadge(payload.character, reloadFn);
            }
        } else {
            console.info('[openclaw-bridge] Not viewing updated character; skipping reload');
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
                try { ws.send(JSON.stringify({ type: 'register', clientType })); } catch (e) {}
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

// Expose a test-friendly global so E2E tests can observe state and trigger actions
globalThis.openclawBridge = globalThis.openclawBridge || { state: STATE, connect, sendSocketMessage };
globalThis.openclawBridgeInit = globalThis.openclawBridgeInit || init;
