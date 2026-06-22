var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// shared/tool-defs.js
var require_tool_defs = __commonJS({
  "shared/tool-defs.js"(exports, module) {
    "use strict";
    var ACTION_TOOL_DEFS2 = [
      {
        type: "send_message",
        displayName: "Send Message",
        description: "Send a message to a configured channel on behalf of this character. Omit recipient to post to the channel's default target; include recipient to send a direct message to that user.",
        parameters: [
          { name: "channel", type: "string", description: 'Name of the configured channel to send on (e.g. "discord", "telegram").', required: true },
          { name: "content", type: "string", description: "The message text to send.", required: true },
          { name: "recipient", type: "string", description: "(Optional) Platform user ID for direct messages. Omit to post to the configured channel target.", required: false }
        ]
      },
      {
        type: "file_write",
        displayName: "Write File",
        description: "Write content to a file in the character's OC workspace.",
        parameters: [
          { name: "path", type: "string", description: "Relative file path within the workspace.", required: true },
          { name: "content", type: "string", description: "The text content to write.", required: true }
        ]
      }
    ];
    var ST_SIDE_TOOL_DEFS2 = [
      {
        type: "write_memory",
        displayName: "Write Memory",
        description: `Write or update a persistent memory entry in this character's lorebook. Use entry_key="core_facts" for the always-active Tier 1 memory (injected every generation \u2014 keep it concise). Use a descriptive key for Tier 2 episode memories that fire on keywords. Updates the existing entry in place; never creates duplicates.`,
        parameters: [
          { name: "entry_key", type: "string", description: 'Unique identifier for this memory, e.g. "core_facts" or "conversation_bridge_project".', required: true },
          { name: "content", type: "string", description: "The memory content to store. For core_facts: one subject per line with comma-separated facts.", required: true },
          { name: "tier", type: "number", description: "1 = always injected (no keywords, default), 2 = keyword-triggered. Use 1 for core facts, 2 for episode memories.", required: false },
          { name: "keywords", type: "string", description: "Comma-separated trigger keywords for tier 2 entries. Ignored for tier 1.", required: false }
        ]
      }
    ];
    module.exports = { ACTION_TOOL_DEFS: ACTION_TOOL_DEFS2, ST_SIDE_TOOL_DEFS: ST_SIDE_TOOL_DEFS2 };
  }
});

// st-extension/src/index.js
var import_tool_defs = __toESM(require_tool_defs());
var eventSource;
var event_types;
var getContext;
var getRequestHeaders;
function ensureSillyTavernApis() {
  if (globalThis.SillyTavern?.getContext) {
    const context = globalThis.SillyTavern.getContext();
    if (context) {
      eventSource = context.eventSource || eventSource;
      event_types = context.eventTypes || event_types;
      getRequestHeaders = context.getRequestHeaders || getRequestHeaders;
    }
  }
  if (typeof window !== "undefined") {
    getContext = getContext || window.getContext;
    eventSource = eventSource || window.eventSource;
    event_types = event_types || window.event_types;
    getRequestHeaders = getRequestHeaders || window.getRequestHeaders;
  }
}
var STATE = {
  socket: null,
  connected: false,
  reconnectTimer: null,
  pending: /* @__PURE__ */ new Map(),
  characterLocks: /* @__PURE__ */ new Map(),
  generationLock: Promise.resolve(),
  pendingActions: /* @__PURE__ */ new Map(),
  // characterName → action[] during active generation
  pendingStSideActions: /* @__PURE__ */ new Map(),
  // characterName → st_side action[] (lorebook writes, etc.)
  notificationRoot: null,
  notificationList: null,
  notificationsCollapsed: false,
  managementRoot: null,
  managementStatus: null,
  managementFields: null,
  managementLoading: false,
  activeCharacterName: null,
  backoffMs: 1e3,
  // exponential backoff, start at 1s
  maxBackoffMs: 3e4,
  // cap at 30s
  healthCheckInterval: null,
  // health ping timer
  pongReceived: true,
  // track if we got a pong back
  pollingInterval: null,
  // single shared HTTP polling fallback timer
  newMessageBadge: null,
  // "new message" badge element for deferred reload
  connectionId: 0,
  // incremented each connect()/connectSse(); stale connections self-close
  lastChatUpdatedTs: 0,
  // deduplicate chat_updated when multiple connections are active
  sseAbortController: null,
  // AbortController for the active SSE fetch
  sseReconnectTimer: null,
  // reconnect backoff timer for SSE
  csrfToken: null,
  // explicitly fetched CSRF token for ST's own CSRF middleware
  bridgeToken: null
  // received from plugin via WS welcome; used as Bearer for HTTP calls
};
function getStContext() {
  if (globalThis.SillyTavern?.getContext) {
    return globalThis.SillyTavern.getContext();
  }
  if (typeof getContext === "function") {
    return getContext();
  }
  return {};
}
function getCharacters() {
  const context = getStContext();
  return Array.isArray(context?.characters) ? context.characters : [];
}
function findCharacterIndex(characterName) {
  return getCharacters().findIndex((character) => character?.name === characterName);
}
function getCurrentCharacterIndex(context) {
  const currentChatId = typeof context?.getCurrentChatId === "function" ? context.getCurrentChatId() : null;
  if (!currentChatId || !Array.isArray(context?.characters)) {
    return -1;
  }
  return context.characters.findIndex((character) => character?.chat === currentChatId);
}
function normalizeGenerationResult(result) {
  if (typeof result === "string") {
    return result;
  }
  return result?.text || result?.response || result?.message || JSON.stringify(result);
}
function stripInstructTemplate(text) {
  if (!text || typeof text !== "string") return text;
  let s = text;
  const chatMlAssistant = s.lastIndexOf("<|im_start|>assistant");
  if (chatMlAssistant !== -1) {
    const afterNewline = s.indexOf("\n", chatMlAssistant);
    s = afterNewline !== -1 ? s.slice(afterNewline + 1) : s.slice(chatMlAssistant + 21);
  }
  const llama3Header = s.lastIndexOf("<|start_header_id|>assistant<|end_header_id|>");
  if (llama3Header !== -1) {
    const afterHeader = s.indexOf("\n\n", llama3Header);
    s = afterHeader !== -1 ? s.slice(afterHeader + 2) : s.slice(llama3Header + 45);
  }
  const lastInstClose = s.lastIndexOf("[/INST]");
  if (lastInstClose !== -1) {
    s = s.slice(lastInstClose + 7);
  }
  const alpacaAssistant = s.lastIndexOf("### Assistant:");
  if (alpacaAssistant !== -1) {
    const afterNewline = s.indexOf("\n", alpacaAssistant);
    s = afterNewline !== -1 ? s.slice(afterNewline + 1) : s.slice(alpacaAssistant + 14);
  }
  s = s.replace(/<\|im_end\|>/g, "").replace(/<\|im_start\|>/g, "").replace(/<\|endoftext\|>/g, "").replace(/<\|eot_id\|>/g, "").replace(/<\/s>/g, "").replace(/^<s>/g, "");
  return s.trim();
}
function resolveCharacterName() {
  const input = document.getElementById("character_name_pole");
  const value = input?.value?.trim();
  if (value) return value;
  const context = getStContext();
  const idx = typeof context?.characterId === "number" ? context.characterId : -1;
  if (idx >= 0 && Array.isArray(context?.characters)) {
    return context.characters[idx]?.name || "";
  }
  return "";
}
function buildPluginHeaders({ omitContentType = false } = {}) {
  const contextHeaders = getStContext()?.getRequestHeaders;
  let headers = {};
  if (typeof contextHeaders === "function") {
    headers = contextHeaders({ omitContentType });
  } else if (typeof getRequestHeaders === "function") {
    headers = getRequestHeaders({ omitContentType });
  }
  if (STATE.csrfToken && !headers["x-csrf-token"] && !headers["X-CSRF-Token"]) {
    headers = Object.assign({}, headers, { "X-CSRF-Token": STATE.csrfToken });
  }
  if (STATE.bridgeToken && !headers["authorization"] && !headers["Authorization"]) {
    headers = Object.assign({}, headers, { Authorization: `Bearer ${STATE.bridgeToken}` });
  }
  return headers;
}
async function fetchCsrfToken() {
  try {
    const resp = await fetch("/csrf-token", { credentials: "same-origin" });
    if (!resp.ok) return;
    const data = await resp.json();
    if (typeof data?.token === "string") {
      STATE.csrfToken = data.token;
      console.info("[openclaw-bridge] CSRF token refreshed");
    }
  } catch (e) {
  }
}
function setManagementStatus(message, tone = "info") {
  if (!STATE.managementStatus) return;
  STATE.managementStatus.textContent = message;
  STATE.managementStatus.classList.remove("is-error", "is-success", "is-muted");
  if (tone === "error") {
    STATE.managementStatus.classList.add("is-error");
  } else if (tone === "success") {
    STATE.managementStatus.classList.add("is-success");
  } else if (tone === "muted") {
    STATE.managementStatus.classList.add("is-muted");
  }
}
function setManagementLoading(isLoading) {
  STATE.managementLoading = isLoading;
  const fields = STATE.managementFields;
  if (!fields) return;
  const { toggleInput, ocAgentInput, ownerIdsInput, channelsContainer, saveButton, testButton } = fields;
  [toggleInput, ocAgentInput, ownerIdsInput, saveButton, testButton].forEach((el) => {
    if (el) el.disabled = isLoading;
  });
  if (channelsContainer) {
    channelsContainer.querySelectorAll("input, button").forEach((el) => {
      el.disabled = isLoading;
    });
  }
}
function parseOwnerIds(rawValue) {
  if (!rawValue) return [];
  return String(rawValue).split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
}
function renderChannelRow(entry = {}) {
  const row = document.createElement("div");
  row.className = "openclaw-bridge-channel-row";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "text_pole openclaw-bridge-channel-name";
  nameInput.placeholder = "name (e.g. discord)";
  nameInput.value = entry.name || "";
  const idInput = document.createElement("input");
  idInput.type = "text";
  idInput.className = "text_pole openclaw-bridge-channel-id";
  idInput.placeholder = "channel_id (e.g. discord-frogbot)";
  idInput.value = entry.channel_id || "";
  const targetInput = document.createElement("input");
  targetInput.type = "text";
  targetInput.className = "text_pole openclaw-bridge-channel-target";
  targetInput.placeholder = "target (optional)";
  targetInput.value = entry.target || "";
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "openclaw-bridge-button openclaw-bridge-button--small";
  removeButton.textContent = "Remove";
  removeButton.addEventListener("click", () => row.remove());
  row.append(nameInput, idInput, targetInput, removeButton);
  return row;
}
function ensureManagementPanel() {
  if (STATE.managementRoot) {
    return STATE.managementRoot;
  }
  const container = document.querySelector("#rm_ch_create_block form");
  if (!container) return null;
  const root = document.createElement("div");
  root.id = "openclaw-bridge-management";
  root.className = "openclaw-bridge-card";
  const header = document.createElement("div");
  header.className = "openclaw-bridge-card__header";
  const title = document.createElement("div");
  title.className = "openclaw-bridge-card__title";
  title.textContent = "External Presence";
  const toggleLabel = document.createElement("label");
  toggleLabel.className = "openclaw-bridge-toggle";
  const toggleInput = document.createElement("input");
  toggleInput.type = "checkbox";
  toggleInput.className = "openclaw-bridge-toggle__input";
  const toggleText = document.createElement("span");
  toggleText.textContent = "Enabled";
  toggleLabel.append(toggleInput, toggleText);
  header.append(title, toggleLabel);
  const body = document.createElement("div");
  body.className = "openclaw-bridge-card__body";
  const agentField = document.createElement("div");
  agentField.className = "openclaw-bridge-field";
  const agentLabel = document.createElement("label");
  agentLabel.textContent = "OC Agent ID";
  const ocAgentInput = document.createElement("input");
  ocAgentInput.type = "text";
  ocAgentInput.className = "text_pole";
  ocAgentInput.placeholder = "e.g. frog";
  agentField.append(agentLabel, ocAgentInput);
  const ownerField = document.createElement("div");
  ownerField.className = "openclaw-bridge-field";
  const ownerLabel = document.createElement("label");
  ownerLabel.textContent = "Owner User IDs";
  const ownerIdsInput = document.createElement("textarea");
  ownerIdsInput.className = "text_pole textarea_compact";
  ownerIdsInput.rows = 2;
  ownerIdsInput.placeholder = "discord:1234, telegram:9876";
  const ownerHint = document.createElement("small");
  ownerHint.textContent = "Comma- or newline-separated. Owners receive [OWNER] label.";
  ownerField.append(ownerLabel, ownerIdsInput, ownerHint);
  const channelsField = document.createElement("div");
  channelsField.className = "openclaw-bridge-field";
  const channelsLabel = document.createElement("label");
  channelsLabel.textContent = "Channels";
  const channelsContainer = document.createElement("div");
  channelsContainer.className = "openclaw-bridge-channels";
  const addChannelButton = document.createElement("button");
  addChannelButton.type = "button";
  addChannelButton.className = "openclaw-bridge-button openclaw-bridge-button--small";
  addChannelButton.textContent = "Add channel";
  addChannelButton.addEventListener("click", () => {
    channelsContainer.append(renderChannelRow());
  });
  const channelsHint = document.createElement("small");
  channelsHint.textContent = "Each channel needs a name and channel_id. Target is optional.";
  channelsField.append(channelsLabel, channelsContainer, addChannelButton, channelsHint);
  const actions = document.createElement("div");
  actions.className = "openclaw-bridge-actions";
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "openclaw-bridge-button";
  saveButton.textContent = "Save link";
  const testButton = document.createElement("button");
  testButton.type = "button";
  testButton.className = "openclaw-bridge-button";
  testButton.textContent = "Test connection";
  actions.append(saveButton, testButton);
  const status = document.createElement("div");
  status.className = "openclaw-bridge-status is-muted";
  status.textContent = "Not configured.";
  const authNote = document.createElement("small");
  authNote.className = "openclaw-bridge-status is-muted";
  authNote.textContent = "Uses current SillyTavern session for auth.";
  body.append(agentField, ownerField, channelsField, actions, authNote, status);
  root.append(header, body);
  container.append(root);
  STATE.managementRoot = root;
  STATE.managementStatus = status;
  STATE.managementFields = {
    toggleInput,
    ocAgentInput,
    ownerIdsInput,
    channelsContainer,
    saveButton,
    testButton
  };
  toggleInput.addEventListener("change", () => {
    saveLinkState();
  });
  saveButton.addEventListener("click", () => {
    saveLinkState();
  });
  testButton.addEventListener("click", () => {
    testConnection();
  });
  return root;
}
async function loadLinkState(characterName) {
  if (!characterName) {
    setManagementStatus("Enter a character name to configure.", "muted");
    return;
  }
  setManagementLoading(true);
  try {
    const response = await fetch(
      `/api/plugins/openclaw-bridge/characters/${encodeURIComponent(characterName)}/link`,
      { method: "GET", headers: buildPluginHeaders({ omitContentType: true }) }
    );
    const fields = STATE.managementFields;
    if (!fields) return;
    if (response.status === 404) {
      fields.ocAgentInput.value = "";
      fields.ownerIdsInput.value = "";
      fields.toggleInput.checked = false;
      fields.channelsContainer.replaceChildren();
      setManagementStatus("Not linked yet.", "muted");
      return;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Failed to load link state (${response.status})`);
    }
    const { link } = await response.json();
    if (link) {
      fields.ocAgentInput.value = link.oc_agent_id || "";
      fields.ownerIdsInput.value = Array.isArray(link.owner_user_ids) ? link.owner_user_ids.join(", ") : "";
      fields.toggleInput.checked = Boolean(link.active);
      fields.channelsContainer.replaceChildren(
        ...(Array.isArray(link.channels) ? link.channels : []).map(renderChannelRow)
      );
      setManagementStatus(`Linked as ${link.oc_agent_id || "unknown"}.`, "success");
    } else {
      fields.ocAgentInput.value = "";
      fields.ownerIdsInput.value = "";
      fields.toggleInput.checked = false;
      fields.channelsContainer.replaceChildren();
      setManagementStatus("Not linked yet.", "muted");
    }
  } catch (error) {
    setManagementStatus(error?.message || "Failed to load link state.", "error");
  } finally {
    setManagementLoading(false);
  }
}
async function saveLinkState() {
  const fields = STATE.managementFields;
  if (!fields) return;
  const characterName = resolveCharacterName();
  if (!characterName) {
    setManagementStatus("Enter a character name before saving.", "error");
    return;
  }
  const ocAgentId = fields.ocAgentInput.value.trim();
  if (!ocAgentId) {
    setManagementStatus("OC Agent ID is required.", "error");
    return;
  }
  const ownerIds = parseOwnerIds(fields.ownerIdsInput.value);
  const channels = [];
  for (const row of fields.channelsContainer.querySelectorAll(".openclaw-bridge-channel-row")) {
    const name = row.querySelector(".openclaw-bridge-channel-name")?.value.trim() || "";
    const channelId = row.querySelector(".openclaw-bridge-channel-id")?.value.trim() || "";
    const target = row.querySelector(".openclaw-bridge-channel-target")?.value.trim() || "";
    if (!name || !channelId) {
      setManagementStatus("Each channel requires a name and channel ID.", "error");
      return;
    }
    const entry = { name, channel_id: channelId };
    if (target) entry.target = target;
    channels.push(entry);
  }
  setManagementLoading(true);
  try {
    const response = await fetch(`/api/plugins/openclaw-bridge/characters/${encodeURIComponent(characterName)}/link`, {
      method: "POST",
      headers: { ...buildPluginHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        oc_agent_id: ocAgentId,
        owner_user_ids: ownerIds,
        active: Boolean(fields.toggleInput.checked),
        channels
      })
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Failed to save link (${response.status})`);
    }
    const payload = await response.json();
    fields.toggleInput.checked = Boolean(payload?.link?.active);
    setManagementStatus("Link saved.", "success");
  } catch (error) {
    setManagementStatus(error?.message || "Failed to save link.", "error");
  } finally {
    setManagementLoading(false);
  }
}
async function testConnection() {
  const fields = STATE.managementFields;
  if (!fields) return;
  const characterName = resolveCharacterName();
  if (!characterName) {
    setManagementStatus("Enter a character name before testing.", "error");
    return;
  }
  setManagementLoading(true);
  try {
    const response = await fetch("/api/plugins/openclaw-bridge/test-notify", {
      method: "POST",
      headers: buildPluginHeaders(),
      body: JSON.stringify({
        character: characterName,
        text: "Test notification from SillyTavern UI"
      })
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Test failed (${response.status})`);
    }
    setManagementStatus("Test notification sent.", "success");
  } catch (error) {
    setManagementStatus(error?.message || "Test failed.", "error");
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
  const root = document.createElement("div");
  root.id = "openclaw-bridge-notifications";
  root.className = "openclaw-bridge-panel is-hidden";
  const header = document.createElement("div");
  header.className = "openclaw-bridge-panel__header";
  const title = document.createElement("span");
  title.className = "openclaw-bridge-panel__title";
  title.textContent = "External Presence";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "openclaw-bridge-panel__toggle";
  toggle.setAttribute("aria-expanded", "true");
  toggle.textContent = "\u25BE";
  toggle.addEventListener("click", () => {
    STATE.notificationsCollapsed = !STATE.notificationsCollapsed;
    root.classList.toggle("is-collapsed", STATE.notificationsCollapsed);
    toggle.setAttribute("aria-expanded", String(!STATE.notificationsCollapsed));
    toggle.textContent = STATE.notificationsCollapsed ? "\u25B8" : "\u25BE";
  });
  header.append(title, toggle);
  const list = document.createElement("div");
  list.className = "openclaw-bridge-panel__list";
  root.append(header, list);
  document.body.append(root);
  STATE.notificationRoot = root;
  STATE.notificationList = list;
  return root;
}
function formatNotificationTime(timestamp) {
  if (!timestamp) return "";
  try {
    return new Date(timestamp).toLocaleTimeString();
  } catch (error) {
    return "";
  }
}
function addNotification({ character, text, timestamp }) {
  if (!text) return;
  const root = ensureNotificationPanel();
  const list = STATE.notificationList;
  if (!list) return;
  root.classList.remove("is-hidden");
  const item = document.createElement("div");
  item.className = "openclaw-bridge-notification";
  const content = document.createElement("div");
  content.className = "openclaw-bridge-notification__content";
  content.textContent = text;
  const meta = document.createElement("div");
  meta.className = "openclaw-bridge-notification__meta";
  const timeLabel = formatNotificationTime(timestamp || Date.now());
  meta.textContent = `${character || "Unknown"}${timeLabel ? ` \u2022 ${timeLabel}` : ""}`;
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "openclaw-bridge-notification__dismiss";
  dismiss.textContent = "\xD7";
  dismiss.addEventListener("click", () => item.remove());
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
    console.error("[openclaw-bridge] Character lock task threw:", err);
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
      return Promise.race([task(...args), timeoutPromise]).finally(() => clearTimeout(timeoutHandle));
    };
  }
  const next = STATE.generationLock.then(wrappedTask, wrappedTask);
  STATE.generationLock = next.catch((err) => {
    console.error("[openclaw-bridge] Generation lock task threw:", err);
  });
  return next;
}
function queueCharacterAction(actionType, params) {
  const ctx = getStContext();
  const charIdx = typeof ctx.characterId === "number" ? ctx.characterId : -1;
  const characterName = charIdx >= 0 ? ctx.characters?.[charIdx]?.name : null;
  if (!characterName) {
    console.warn("[openclaw-bridge] Tool called but no active character in context");
    return JSON.stringify({ success: false, error: "No active character" });
  }
  const pending = STATE.pendingActions.get(characterName);
  if (!pending) {
    console.warn("[openclaw-bridge] Tool called outside of an active generation for:", characterName);
    return JSON.stringify({ success: false, error: "No active generation context" });
  }
  pending.push({ type: actionType, ...params });
  console.info("[openclaw-bridge] Queued character action:", actionType, "for", characterName);
  return JSON.stringify({ success: true, message: `Action queued: ${actionType}` });
}
function queueStSideAction(actionType, params) {
  const ctx = getStContext();
  const charIdx = typeof ctx.characterId === "number" ? ctx.characterId : -1;
  const characterName = charIdx >= 0 ? ctx.characters?.[charIdx]?.name : null;
  if (!characterName) {
    console.warn("[openclaw-bridge] st_side tool called but no active character");
    return JSON.stringify({ success: false, error: "No active character" });
  }
  const pending = STATE.pendingStSideActions.get(characterName);
  if (!pending) {
    console.warn("[openclaw-bridge] st_side tool called outside active generation for:", characterName);
    return JSON.stringify({ success: false, error: "No active generation context" });
  }
  pending.push({ type: actionType, ...params });
  console.info("[openclaw-bridge] Queued st_side action:", actionType, "for", characterName);
  return JSON.stringify({ success: true, message: `Memory queued: ${actionType}` });
}
function registerBridgeTools() {
  const context = getStContext();
  if (typeof context?.registerFunctionTool !== "function") {
    console.warn("[openclaw-bridge] registerFunctionTool not available in ST context \u2014 skipping tool registration");
    return;
  }
  function toStParams(def) {
    return {
      type: "object",
      properties: Object.fromEntries(def.parameters.map((p) => [p.name, { type: p.type, description: p.description }])),
      required: def.parameters.filter((p) => p.required).map((p) => p.name)
    };
  }
  for (const def of import_tool_defs.ACTION_TOOL_DEFS) {
    context.registerFunctionTool({
      name: `openclaw_${def.type}`,
      displayName: def.displayName,
      description: def.description,
      parameters: toStParams(def),
      stealth: true,
      action: async (params) => queueCharacterAction(def.type, params)
    });
  }
  for (const def of import_tool_defs.ST_SIDE_TOOL_DEFS) {
    context.registerFunctionTool({
      name: `openclaw_${def.type}`,
      displayName: def.displayName,
      description: def.description,
      parameters: toStParams(def),
      stealth: true,
      action: async (params) => queueStSideAction(def.type, params)
    });
  }
  const allRegistered = [
    ...import_tool_defs.ACTION_TOOL_DEFS.map((d) => `openclaw_${d.type}`),
    ...import_tool_defs.ST_SIDE_TOOL_DEFS.map((d) => `openclaw_${d.type}`)
  ];
  console.info("[openclaw-bridge] Registered bridge function tools:", allRegistered);
}
async function generateForCharacter(characterName, message, pluginTimeoutMs) {
  const timeoutMs = pluginTimeoutMs ? Math.max(pluginTimeoutMs - 3e4, 1e4) : 84e4;
  return withGenerationLock(async () => {
    const context = getStContext();
    let { generate, generateQuietPrompt, sendGenerationRequest, selectCharacterById } = context;
    console.info("[openclaw-bridge] generateForCharacter called with:", { characterName, messageLength: message?.length });
    console.info("[openclaw-bridge] Context functions available:", {
      hasGenerate: typeof generate === "function",
      hasGenerateQuietPrompt: typeof generateQuietPrompt === "function",
      hasSendGenerationRequest: typeof sendGenerationRequest === "function",
      hasSelectCharacterById: typeof selectCharacterById === "function",
      hasContext: !!context,
      contextKeys: context ? Object.keys(context).slice(0, 20) : "NO CONTEXT"
    });
    const chid = await (async () => {
      const deadline = Date.now() + 3e4;
      let firstSeen = false;
      while (Date.now() < deadline) {
        const chars = getCharacters();
        if (chars.length > 0) {
          if (!firstSeen) {
            firstSeen = true;
            console.info(
              "[openclaw-bridge] character list loaded, count:",
              chars.length,
              "first:",
              JSON.stringify({ name: chars[0]?.name, avatar: chars[0]?.avatar })
            );
          }
          const idx = chars.findIndex((c) => c?.name === characterName);
          if (idx !== -1) return idx;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return -1;
    })();
    if (chid === -1) {
      const available = getCharacters().map((c) => c?.name).filter(Boolean);
      throw new Error(`Character not found: ${characterName}. Available: ${JSON.stringify(available)}`);
    }
    const previousChid = getCurrentCharacterIndex(context);
    const needsCharacterSwitch = previousChid !== chid;
    const isHeadless = globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE === "headless";
    sendSocketMessage({
      type: "debug_log",
      level: "info",
      event: "char_switch_decision",
      characterName,
      chid,
      previousChid,
      needsCharacterSwitch,
      isHeadless,
      hasSelectCharacterById: typeof selectCharacterById === "function",
      hasExecuteSlash: typeof context?.executeSlashCommandsWithOptions === "function"
    });
    if (isHeadless) {
      if (needsCharacterSwitch) {
        console.info("[openclaw-bridge] Headless: switching active character before generation", { from: previousChid, to: chid, characterName });
      } else {
        console.info("[openclaw-bridge] Headless: reloading chat from disk before generation", { chid, characterName });
      }
      if (typeof selectCharacterById === "function") {
        try {
          await selectCharacterById(chid);
        } catch (switchErr) {
          sendSocketMessage({
            type: "debug_log",
            level: "error",
            event: "char_switch_error",
            method: "selectCharacterById",
            error: switchErr?.message
          });
        }
      }
      await new Promise((r) => setTimeout(r, 300));
      const postSwitchCtx = getStContext();
      const postSwitchChid = Number(postSwitchCtx?.characterId);
      const postSwitchName2 = postSwitchCtx?.name2;
      sendSocketMessage({
        type: "debug_log",
        level: "info",
        event: "char_switch_after_primary",
        postSwitchChid,
        postSwitchName2,
        targetChid: chid,
        targetName: characterName,
        switchOk: postSwitchChid === chid
      });
      if (postSwitchChid !== chid && typeof context?.executeSlashCommandsWithOptions === "function") {
        console.info("[openclaw-bridge] Headless: primary switch failed, trying /go command");
        try {
          await context.executeSlashCommandsWithOptions(`/go ${characterName}`);
          await new Promise((r) => setTimeout(r, 500));
          const fallbackCtx = getStContext();
          sendSocketMessage({
            type: "debug_log",
            level: "info",
            event: "char_switch_after_fallback",
            characterId: Number(fallbackCtx?.characterId),
            name2: fallbackCtx?.name2,
            targetChid: chid
          });
        } catch (fallbackErr) {
          sendSocketMessage({
            type: "debug_log",
            level: "error",
            event: "char_switch_fallback_error",
            error: fallbackErr?.message
          });
        }
      }
    } else if (needsCharacterSwitch) {
      sendSocketMessage({
        type: "debug_log",
        level: "info",
        event: "char_switch_skipped",
        reason: "not headless",
        chid,
        characterName,
        previousChid
      });
    }
    let result;
    const preGenCtx = getStContext();
    sendSocketMessage({
      type: "debug_log",
      level: "info",
      event: "pre_generation_state",
      characterId: Number(preGenCtx?.characterId),
      name2: preGenCtx?.name2,
      chatId: preGenCtx?.chatId,
      targetChid: chid,
      targetName: characterName
    });
    console.info("[openclaw-bridge] Attempting generation with message:", { characterName, messagePreview: message?.substring(0, 100) });
    let debugMethod = null;
    let debugLog = [];
    const previousName2 = typeof name2 !== "undefined" ? name2 : void 0;
    let nameOverridden = false;
    try {
      if (typeof setCharacterName === "function") {
        try {
          setCharacterName(characterName);
          nameOverridden = true;
          debugLog.push(`setCharacterName -> ${characterName}`);
          console.info("[openclaw-bridge] Temporarily set name2 for generation to:", characterName);
        } catch (e) {
          console.warn("[openclaw-bridge] setCharacterName failed:", e);
          debugLog.push(`setCharacterName failed: ${e.message}`);
        }
      } else if (typeof globalThis.setCharacterName === "function") {
        try {
          globalThis.setCharacterName(characterName);
          nameOverridden = true;
          debugLog.push(`global setCharacterName -> ${characterName}`);
        } catch (e) {
          console.warn("[openclaw-bridge] global setCharacterName failed:", e);
          debugLog.push(`global setCharacterName failed: ${e.message}`);
        }
      } else {
        debugLog.push("setCharacterName not available; forceChId handles character targeting");
      }
      if (typeof generateQuietPrompt === "function") {
        debugMethod = "context.generateQuietPrompt";
        console.info("[openclaw-bridge] Using context.generateQuietPrompt()");
        debugLog.push("Using context.generateQuietPrompt()");
        result = await generateQuietPrompt({
          quietPrompt: message,
          forceChId: chid,
          skipWIAN: false,
          quietToLoud: true,
          removeReasoning: false,
          trimToSentence: false
        });
        debugLog.push(`generateQuietPrompt returned: ${typeof result} (${result?.length || 0} chars)`);
        if (!result && typeof generate === "function") {
          console.warn("[openclaw-bridge] generateQuietPrompt returned empty; falling back to generate()");
          debugLog.push("generateQuietPrompt was empty; falling back to generate()");
          result = await generate("quiet", {
            quiet_prompt: message,
            force_chid: chid,
            force_name2: true,
            skipWIAN: false,
            quietToLoud: true
          });
          debugLog.push(`generate() fallback returned: ${typeof result} (${result?.length || 0} chars)`);
        }
      } else if (typeof generate === "function") {
        debugMethod = "context.generate";
        console.info("[openclaw-bridge] Using context.generate()");
        debugLog.push("Using context.generate()");
        try {
          console.info("[openclaw-bridge] Calling generate with params:", { quiet_prompt: message.substring(0, 50), force_chid: chid, force_name2: true, quietToLoud: true });
          result = await generate("quiet", {
            quiet_prompt: message,
            force_chid: chid,
            force_name2: true,
            skipWIAN: false,
            quietToLoud: true
          });
          console.info("[openclaw-bridge] generate() returned:", { type: typeof result, length: result?.length, preview: typeof result === "string" ? result.substring(0, 100) : result });
          debugLog.push(`generate() returned ${typeof result}: ${result?.substring?.(0, 100) || JSON.stringify(result)}`);
        } catch (genErr) {
          console.error("[openclaw-bridge] generate() threw error:", genErr);
          debugLog.push(`generate() ERROR: ${genErr.message}`);
          throw genErr;
        }
      } else if (typeof context?.Generate === "function") {
        debugMethod = "context.Generate";
        console.info("[openclaw-bridge] Using context.Generate()");
        debugLog.push("Using context.Generate()");
        result = await context.Generate("quiet", {
          quiet_prompt: message,
          force_chid: chid,
          force_name2: true,
          skipWIAN: false,
          quietToLoud: true
        });
        debugLog.push(`context.Generate returned: ${typeof result} (${result?.length || 0} chars)`);
      } else if (typeof Generate === "function") {
        debugMethod = "global.Generate";
        console.info("[openclaw-bridge] Using global Generate()");
        debugLog.push("Using global Generate()");
        result = await Generate("quiet", {
          quiet_prompt: message,
          force_chid: chid,
          force_name2: true,
          skipWIAN: false,
          quietToLoud: true
        });
        debugLog.push(`Generate returned: ${typeof result} (${result?.length || 0} chars)`);
      } else if (typeof sendGenerationRequest === "function") {
        debugMethod = "context.sendGenerationRequest";
        console.info("[openclaw-bridge] Using context.sendGenerationRequest()");
        debugLog.push("Using context.sendGenerationRequest()");
        result = await sendGenerationRequest("quiet", {
          prompt: message,
          force_chid: chid,
          quiet_prompt: message,
          stream: false
        }, { removeReasoning: false, trimToSentence: false, quietToLoud: true });
        if (result && typeof result === "object" && "text" in result && typeof result.text === "string") {
          result = result.text;
        }
        debugLog.push(`sendGenerationRequest returned: ${typeof result} (${result?.length || 0} chars)`);
      } else {
        debugLog.push("No Generate API found; polling briefly for availability");
        const pollDeadline = Date.now() + 2e3;
        let foundApi = false;
        while (Date.now() < pollDeadline) {
          const ctx = getStContext();
          if (ctx && (typeof ctx.generate === "function" || typeof ctx.generateQuietPrompt === "function" || typeof ctx.sendGenerationRequest === "function" || typeof ctx.Generate === "function")) {
            foundApi = true;
            debugLog.push("Generate API became available during poll");
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!foundApi) {
          debugLog.push("ERROR: No Generate API available in the SillyTavern context after polling");
          throw new Error("No Generate API available in the SillyTavern context");
        }
        try {
          const refreshed = getStContext();
          ({ generate, generateQuietPrompt, sendGenerationRequest, selectCharacterById } = refreshed || {});
          debugLog.push("Refreshed context function references after poll");
        } catch (e) {
          debugLog.push("Failed to refresh context functions after poll: " + (e?.message || String(e)));
        }
      }
    } finally {
      if (nameOverridden && typeof setCharacterName === "function") {
        if (typeof previousName2 === "string") {
          try {
            setCharacterName(previousName2);
            debugLog.push(`restored name2 -> ${previousName2}`);
            console.info("[openclaw-bridge] Restored original name2 after generation");
          } catch (e) {
            console.warn("[openclaw-bridge] Failed to restore name2:", e);
            debugLog.push(`restore name2 failed: ${e.message}`);
          }
        }
      }
    }
    sendSocketMessage({
      type: "debug_log",
      level: "info",
      event: "generation_debug",
      method: debugMethod,
      logs: debugLog,
      resultType: typeof result,
      resultLength: result?.length || 0
    });
    try {
      sendSocketMessage({ type: "debug_log", level: "info", event: "generation_method", method: debugMethod, rawType: typeof result, preview: typeof result === "string" ? result.substring(0, 200) : void 0 });
    } catch (e) {
      console.warn("[openclaw-bridge] Failed to send debug_log over socket", e);
    }
    console.info("[openclaw-bridge] Generation result (raw):", { type: typeof result, length: result?.length, preview: typeof result === "string" ? result.substring(0, 100) : result });
    const normalized = stripInstructTemplate(normalizeGenerationResult(result));
    console.info("[openclaw-bridge] Final normalized result:", { length: normalized?.length, preview: normalized?.substring(0, 100) });
    return normalized;
  }, timeoutMs);
}
async function handleGenerateRequest(payload) {
  const { requestId, character, message, timeout_ms } = payload;
  console.info("[openclaw-bridge] handleGenerateRequest received:", { requestId, character, messagePreview: message?.substring(0, 50) });
  try {
    console.info("[openclaw-bridge] Starting generation with character lock");
    const response = await withCharacterLock(character, () => {
      STATE.pendingActions.set(character, []);
      STATE.pendingStSideActions.set(character, []);
      return generateForCharacter(character, message, timeout_ms);
    });
    const actions = STATE.pendingActions.get(character) || [];
    const stSideActions = STATE.pendingStSideActions.get(character) || [];
    console.info("[openclaw-bridge] Generation completed:", { requestId, responseLength: response?.length, actionsCount: actions.length, stSideActionsCount: stSideActions.length, responsePreview: response?.substring(0, 100) });
    if (response == null) {
      sendSocketMessage({ type: "generate_error", requestId, error: "Generation returned null/undefined \u2014 check LLM model/connection" });
      return;
    }
    sendSocketMessage({
      type: "generate_response",
      requestId,
      response,
      actions,
      st_side_actions: stSideActions
    });
  } catch (error) {
    console.error("[openclaw-bridge] Generation failed:", { requestId, error: error?.message || String(error), stack: error?.stack });
    sendSocketMessage({
      type: "generate_error",
      requestId,
      error: error?.message || String(error)
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
    console.error("[openclaw-bridge] Socket send failed:", err.message);
    try {
      STATE.socket.close();
    } catch (_) {
    }
  }
}
function startHttpPollingFallback() {
  if (STATE.pollingInterval) return;
  console.info("[openclaw-bridge] Starting HTTP polling fallback for plugin messages");
  let poll404Count = 0;
  STATE.pollingInterval = setInterval(async () => {
    try {
      const headers = buildPluginHeaders({ omitContentType: true }) || {};
      const clientType = globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE || "ui";
      const resp = await fetch(`/api/plugins/openclaw-bridge/http-message?clientType=${clientType}`, {
        method: "GET",
        credentials: "same-origin",
        headers
      });
      if (resp.status === 204) return;
      if (resp.status === 404) {
        poll404Count += 1;
        if (poll404Count === 1) console.warn("[openclaw-bridge] HTTP polling returned 404; plugin route may be missing");
        return;
      }
      if (!resp.ok) {
        console.warn("[openclaw-bridge] HTTP polling returned:", resp.status);
        return;
      }
      poll404Count = 0;
      const msg = await resp.json();
      console.info("[openclaw-bridge] Polled HTTP message:", msg.type, msg.requestId);
      if (msg.type === "generate") {
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
        const responseBody = JSON.stringify({ type: "generate_response", requestId: msg.requestId, response: responseText, actions, st_side_actions: stSideActions });
        let postResp = await fetch("/api/plugins/openclaw-bridge/http-response", {
          method: "POST",
          credentials: "same-origin",
          headers: Object.assign({ "Content-Type": "application/json" }, buildPluginHeaders()),
          body: responseBody
        });
        if (postResp.status === 403) {
          STATE.csrfToken = null;
          await fetchCsrfToken();
          postResp = await fetch("/api/plugins/openclaw-bridge/http-response", {
            method: "POST",
            credentials: "same-origin",
            headers: Object.assign({ "Content-Type": "application/json" }, buildPluginHeaders()),
            body: responseBody
          });
          if (!postResp.ok) {
            console.warn("[openclaw-bridge] HTTP response POST retry failed:", postResp.status);
          }
        }
      } else if (msg.type === "chat_updated") {
        if (!STATE.connected) {
          console.info("[openclaw-bridge] chat_updated received via HTTP poll:", { character: msg.character });
          await handleChatUpdatedMessage(msg);
        }
      }
    } catch (e) {
      console.warn("[openclaw-bridge] HTTP polling error:", e);
    }
  }, 2e3);
}
function stopHttpPollingFallback() {
  if (!STATE.pollingInterval) return;
  clearInterval(STATE.pollingInterval);
  STATE.pollingInterval = null;
  console.info("[openclaw-bridge] Stopped HTTP polling fallback");
}
async function handleChatUpdatedMessage(payload) {
  if (globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE === "headless") return;
  if (payload.timestamp && payload.timestamp === STATE.lastChatUpdatedTs) {
    console.info("[openclaw-bridge] chat_updated duplicate ignored:", payload.character);
    return;
  }
  if (payload.timestamp) STATE.lastChatUpdatedTs = payload.timestamp;
  try {
    const context = getStContext();
    const updatedChid = findCharacterIndex(payload.character);
    const currentChid = typeof context?.characterId === "number" ? context.characterId : getCurrentCharacterIndex(context);
    const reloadFn = context?.reloadCurrentChat || (typeof reloadCurrentChat === "function" ? reloadCurrentChat : null);
    console.info("[openclaw-bridge] chat_updated check:", {
      updatedChid,
      currentChid,
      contextCharacterId: context?.characterId,
      hasReloadFn: typeof reloadFn === "function",
      charactersCount: context?.characters?.length
    });
    if (updatedChid !== -1 && currentChid === updatedChid) {
      if (typeof reloadFn !== "function") {
        console.warn("[openclaw-bridge] reloadCurrentChat() is not available in this context");
      } else if (isAtChatBottom()) {
        console.info("[openclaw-bridge] At chat bottom; reloading");
        hideNewMessageBadge();
        await reloadFn();
        console.info("[openclaw-bridge] reloadCurrentChat completed");
      } else {
        console.info("[openclaw-bridge] Scrolled up; showing new message badge");
        showNewMessageBadge(payload.character, reloadFn);
      }
    } else {
      console.info("[openclaw-bridge] Not viewing updated character; skipping reload");
    }
  } catch (e) {
    console.warn("[openclaw-bridge] Error handling chat_updated:", e);
  }
}
function isAtChatBottom() {
  const chatEl = document.getElementById("chat");
  if (!chatEl) return true;
  return chatEl.scrollHeight - chatEl.scrollTop <= chatEl.clientHeight + 60;
}
function showNewMessageBadge(characterName, reloadFn) {
  hideNewMessageBadge();
  const chat = document.getElementById("chat");
  if (!chat) {
    console.warn("[openclaw-bridge] #chat not found; cannot show new message badge");
    return;
  }
  const wrapper = document.createElement("div");
  wrapper.id = "openclaw-bridge-new-msg-badge";
  wrapper.style.cssText = "position:sticky;bottom:10px;text-align:center;z-index:100;pointer-events:none;margin:4px 0;";
  const btn = document.createElement("button");
  btn.style.cssText = "pointer-events:auto;background:#4a9eff;color:#fff;border:none;border-radius:16px;padding:6px 18px;font-size:13px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.35);white-space:nowrap;";
  btn.textContent = `\u2193 New message from ${characterName}`;
  btn.onclick = async () => {
    hideNewMessageBadge();
    if (typeof reloadFn === "function") await reloadFn();
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
  if (payload.type === "chat_updated") {
    console.info("[openclaw-bridge] chat_updated received via SSE:", { character: payload.character });
    await handleChatUpdatedMessage(payload);
  } else if (payload.type === "notification") {
    addNotification(payload);
  }
}
function connectSse() {
  if (STATE.sseAbortController) {
    try {
      STATE.sseAbortController.abort();
    } catch (e) {
    }
    STATE.sseAbortController = null;
  }
  const myConnectionId = ++STATE.connectionId;
  async function attempt() {
    if (STATE.connectionId !== myConnectionId) return;
    const controller = new AbortController();
    STATE.sseAbortController = controller;
    try {
      const headers = Object.assign(
        { Accept: "text/event-stream" },
        buildPluginHeaders({ omitContentType: true }) || {}
      );
      const response = await fetch("/api/plugins/openclaw-bridge/events", {
        credentials: "same-origin",
        headers,
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`SSE endpoint responded ${response.status}`);
      }
      STATE.connected = true;
      STATE.backoffMs = 1e3;
      startHttpPollingFallback();
      console.info("[openclaw-bridge] SSE connected");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop();
        for (const block of blocks) {
          if (!block.trim() || block.startsWith(":")) continue;
          const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const payload = JSON.parse(dataLine.slice(6));
            await handleSseMessage(payload);
          } catch (e) {
            console.warn("[openclaw-bridge] SSE parse error:", e);
          }
        }
      }
      throw new Error("SSE stream ended");
    } catch (e) {
      if (e.name === "AbortError") return;
      if (STATE.connectionId !== myConnectionId) return;
      STATE.connected = false;
      STATE.sseAbortController = null;
      STATE.backoffMs = Math.min(STATE.backoffMs * 1.5, STATE.maxBackoffMs);
      console.info(`[openclaw-bridge] SSE disconnected (${e.message}), reconnecting in ${STATE.backoffMs}ms`);
      startHttpPollingFallback();
      STATE.sseReconnectTimer = setTimeout(attempt, STATE.backoffMs);
    }
  }
  attempt();
}
function connect() {
  console.log("[openclaw-bridge] connect() called, current STATE:", { connected: STATE.connected, hasSocket: !!STATE.socket });
  if (STATE.socket && (STATE.socket.readyState === WebSocket.OPEN || STATE.socket.readyState === WebSocket.CONNECTING)) {
    console.log("[openclaw-bridge] Already connected or connecting, skipping");
    return;
  }
  const myConnectionId = ++STATE.connectionId;
  function getWebSocketUrl() {
    console.log("[openclaw-bridge] getWebSocketUrl() called");
    if (globalThis.OPENCLAW_BRIDGE_WS_URL) {
      console.info("[openclaw-bridge] Using override WS URL:", globalThis.OPENCLAW_BRIDGE_WS_URL);
      return globalThis.OPENCLAW_BRIDGE_WS_URL;
    }
    const port = globalThis.OPENCLAW_BRIDGE_WS_PORT || 8765;
    const protocol = typeof location !== "undefined" && location.protocol === "https:" ? "wss:" : "ws:";
    let host = typeof location !== "undefined" && location.hostname ? location.hostname : "localhost";
    if (host === "127.0.0.1") {
      console.log("[openclaw-bridge] Using localhost instead of 127.0.0.1 to work around browser cross-port restrictions");
      host = "localhost";
    }
    const url = `${protocol}//${host}:${port}`;
    console.info("[openclaw-bridge] Derived WS URL from page:", { protocol, host, port, url });
    return url;
  }
  try {
    let attachHandlers = function(ws) {
      ws.addEventListener("open", () => {
        if (STATE.connectionId !== myConnectionId) {
          try {
            ws.close();
          } catch (e) {
          }
          return;
        }
        if (connected) return;
        connected = true;
        STATE.socket = ws;
        STATE.connected = true;
        STATE.backoffMs = 1e3;
        STATE.pongReceived = true;
        console.info("[openclaw-bridge] \u2705 WebSocket connected!");
        stopHttpPollingFallback();
        startHealthCheck();
        fetchCsrfToken().catch(() => {
        });
        const clientType = globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE || "ui";
        const regToken = globalThis.OPENCLAW_BRIDGE_BRIDGE_TOKEN || STATE.bridgeToken || void 0;
        try {
          ws.send(JSON.stringify({ type: "register", clientType, token: regToken }));
        } catch (e) {
        }
      });
      ws.addEventListener("message", async (event) => {
        if (STATE.connectionId !== myConnectionId) return;
        console.log("[openclaw-bridge] Message received on WebSocket:", String(event.data).substring(0, 200));
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch (error) {
          console.error("[openclaw-bridge] Failed to parse message:", error);
          return;
        }
        console.log("[openclaw-bridge] Parsed payload type:", payload.type);
        if (payload.type === "pong") {
          STATE.pongReceived = true;
          console.log("[openclaw-bridge] Pong received");
          return;
        }
        if (payload.type === "welcome") {
          if (typeof payload.bridgeToken === "string" && payload.bridgeToken) {
            STATE.bridgeToken = payload.bridgeToken;
          }
          return;
        }
        if (payload.type === "generate") {
          console.info("[openclaw-bridge] \u26A1 GENERATE REQUEST RECEIVED:", { character: payload.character, messageLength: payload.message?.length });
          await handleGenerateRequest(payload);
          return;
        }
        if (payload.type === "chat_updated") {
          console.info("[openclaw-bridge] chat_updated received via WS:", { character: payload.character });
          await handleChatUpdatedMessage(payload);
          return;
        }
        if (payload.type === "notification") {
          addNotification(payload);
        }
      });
      ws.addEventListener("close", (ev) => {
        if (STATE.connectionId !== myConnectionId) return;
        STATE.connected = false;
        fetchCsrfToken().catch(() => {
        });
        if (STATE.reconnectTimer) {
          clearTimeout(STATE.reconnectTimer);
        }
        if (STATE.healthCheckInterval) {
          clearInterval(STATE.healthCheckInterval);
          STATE.healthCheckInterval = null;
        }
        STATE.backoffMs = Math.min(STATE.backoffMs * 1.5, STATE.maxBackoffMs);
        console.info(`[openclaw-bridge] WebSocket closed. Reconnecting in ${STATE.backoffMs}ms`);
        startHttpPollingFallback();
        STATE.reconnectTimer = setTimeout(connect, STATE.backoffMs);
      });
      ws.addEventListener("error", (event) => {
        console.error("[openclaw-bridge] WebSocket error event:", event, "url:", ws.url, "readyState:", ws.readyState);
        if (!connected) {
          try {
            ws.close();
          } catch (e) {
          }
          socket = null;
          tried += 1;
          if (tried < urls.length) {
            console.info("[openclaw-bridge] Trying next WebSocket URL:", urls[tried]);
            tryConnect();
          } else {
            startHttpPollingFallback();
          }
        }
        try {
          sendSocketMessage({
            type: "debug_log",
            level: "error",
            event: "ws_error",
            message: event?.message || "unknown WS error",
            readyState: STATE.socket?.readyState
          });
        } catch (e) {
        }
      });
    }, tryConnect = function() {
      const url = urls[tried];
      console.log("[openclaw-bridge] Creating WebSocket to:", url);
      try {
        socket = new WebSocket(url);
        attachHandlers(socket);
      } catch (err) {
        console.error("[openclaw-bridge] Failed to create WebSocket to", url, err);
        tried += 1;
        if (tried < urls.length) {
          console.info("[openclaw-bridge] Trying next WebSocket URL:", urls[tried]);
          setTimeout(tryConnect, 200);
        } else {
          STATE.backoffMs = Math.min(STATE.backoffMs * 1.5, STATE.maxBackoffMs);
          console.warn("[openclaw-bridge] Unable to create WebSocket to any URL. Falling back to HTTP polling.");
          startHttpPollingFallback();
        }
      }
    };
    const candidateHosts = [];
    const pageHost = typeof location !== "undefined" && location.hostname ? location.hostname : null;
    if (pageHost) candidateHosts.push(pageHost);
    candidateHosts.push("localhost", "127.0.0.1", "::1");
    const hosts = Array.from(new Set(candidateHosts));
    const protocol = typeof location !== "undefined" && location.protocol === "https:" ? "wss:" : "ws:";
    const port = globalThis.OPENCLAW_BRIDGE_WS_PORT || 8765;
    const urls = hosts.map((h) => `${protocol}//${h}:${port}`);
    console.log("[openclaw-bridge] Attempting WebSocket URLs:", urls);
    let socket = null;
    let tried = 0;
    let connected = false;
    tryConnect();
  } catch (err) {
    console.error("[openclaw-bridge] \u274C Unexpected error in connect():", err);
  }
}
function startHealthCheck() {
  if (STATE.healthCheckInterval) {
    clearInterval(STATE.healthCheckInterval);
  }
  STATE.healthCheckInterval = setInterval(() => {
    if (!STATE.socket || STATE.socket.readyState !== WebSocket.OPEN) {
      clearInterval(STATE.healthCheckInterval);
      STATE.healthCheckInterval = null;
      return;
    }
    STATE.pongReceived = false;
    console.debug("[openclaw-bridge] Health check: sending ping");
    try {
      sendSocketMessage({ type: "ping" });
    } catch (e) {
      console.warn("[openclaw-bridge] Failed to send health check ping:", e);
    }
    setTimeout(() => {
      if (!STATE.pongReceived) {
        console.warn("[openclaw-bridge] Health check failed (no pong); reconnecting");
        if (STATE.socket) STATE.socket.close();
      }
    }, 5e3);
  }, 3e4);
}
function init() {
  if (typeof window !== "undefined") {
    if (window.__openclawBridgeLoaded) {
      console.warn("[openclaw-bridge] init() skipped \u2014 extension already loaded on this page");
      return;
    }
    window.__openclawBridgeLoaded = true;
  }
  console.log("[openclaw-bridge] ===== INIT CALLED =====");
  try {
    const clientType = globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE || "ui";
    console.log("[openclaw-bridge] Step 1: Adding small delay before connecting (ST may still be initializing)", { clientType });
    setTimeout(async () => {
      try {
        await fetchCsrfToken();
        if (clientType === "headless") {
          console.log("[openclaw-bridge] Step 2: Headless client \u2014 attempting WebSocket connection");
          connect();
        } else {
          console.log("[openclaw-bridge] Step 2: UI client \u2014 connecting via SSE");
          connectSse();
        }
        ensureSillyTavernApis();
        registerBridgeTools();
        registerManagementPanelHooks();
        console.log("[openclaw-bridge] Step 3: connection attempt started");
      } catch (e) {
        console.error("[openclaw-bridge] \u274C ERROR in delayed init():", e);
      }
    }, 2e3);
  } catch (e) {
    console.error("[openclaw-bridge] \u274C ERROR in init():", e);
  }
  console.log("[openclaw-bridge] ===== INIT DONE =====");
}
if (!globalThis.openclawBridge) {
  globalThis.openclawBridge = { state: STATE, connect, sendSocketMessage };
}
globalThis.openclawBridge.refreshManagementPanel = refreshManagementPanel;
globalThis.openclawBridgeLoadLinkState = loadLinkState;
globalThis.openclawBridgeInit = globalThis.openclawBridgeInit || init;
export {
  generateForCharacter,
  init
};
