import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// Default data dir: ~/.openclaw/openclaw-bridge/
// setup.sh symlinks bridge-token.txt and character-links.json here so the
// plugin works without any env vars on single-machine deployments.
const OC_BRIDGE_DATA = process.env.OPENCLAW_BRIDGE_DATA_DIR ??
    resolve(homedir(), ".openclaw", "openclaw-bridge");
const LINKS_FILE = process.env.OPENCLAW_BRIDGE_LINKS_PATH ??
    resolve(OC_BRIDGE_DATA, "character-links.json");
const TOKEN_FILE = resolve(OC_BRIDGE_DATA, "bridge-token.txt");
// ST_BASE must be http (not https) and must point at the host running ST.
// OPENCLAW_BRIDGE_URL is intentionally NOT used here — that variable is for
// the character-bridge skill and may be https or lack the plugin path prefix.
const ST_BASE = process.env.OPENCLAW_BRIDGE_ST_URL ?? "http://127.0.0.1:8000";
const HEARTBEAT_TIMEOUT_MS = parseInt(process.env.OPENCLAW_BRIDGE_HEARTBEAT_TIMEOUT_MS ?? "60000", 10);
function readLinkState() {
    try {
        const raw = readFileSync(LINKS_FILE, "utf8");
        const parsed = JSON.parse(raw || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
const senderCache = new Map();
const SENDER_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
function senderCacheKey(channelId, senderId) {
    return `${channelId}\x00${senderId}`;
}
function pruneExpiredSenderCache() {
    const now = Date.now();
    for (const [key, entry] of senderCache) {
        if (now - entry.cachedAt > SENDER_CACHE_TTL_MS)
            senderCache.delete(key);
    }
}
// Pull the display name out of a hook event. message_received carries it at
// metadata.senderName; inbound_claim (legacy shape) at the top level. Returns a
// trimmed non-empty string or null.
export function extractSenderName(event) {
    const raw = event?.metadata?.senderName ?? event?.senderName ?? null;
    if (typeof raw !== "string")
        return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}
// Cache a sender's name (and optionally avatar) under the (channelId, senderId)
// key that before_dispatch reads. A null name preserves any previously cached
// name (e.g. an async avatar fill must not wipe the name). Returns the cache key,
// or null when channelId/senderId are missing (nothing written).
export function cacheSender(channelId, senderId, name, opts) {
    if (!channelId || !senderId)
        return null;
    const cache = opts?.cache ?? senderCache;
    const now = opts?.now ?? Date.now();
    const key = senderCacheKey(channelId, senderId);
    const existing = cache.get(key);
    cache.set(key, {
        name: name ?? existing?.name ?? null,
        avatarUrl: opts?.avatarUrl ?? existing?.avatarUrl ?? null,
        cachedAt: now,
    });
    return key;
}
export function lookupSender(channelId, senderId, cache = senderCache) {
    if (!channelId || !senderId)
        return null;
    return cache.get(senderCacheKey(channelId, senderId)) ?? null;
}
const heartbeatState = new Map();
const runningHeartbeats = new Set();
let heartbeatTimer = null;
function getOrCreateHeartbeatState(character) {
    let s = heartbeatState.get(character);
    if (!s) {
        const now = Date.now();
        s = { lastHeartbeatAt: now, lastMessageAt: now, idleHeartbeatFiredAt: 0 };
        heartbeatState.set(character, s);
    }
    return s;
}
// ---------------------------------------------------------------------------
// Read the Discord bot token from the OC config for the given account.
// Returns null if no plain-string token is found (SecretRef values cannot be
// resolved without the OC secrets runtime).
function resolveDiscordToken(cfg, accountId) {
    const discordCfg = cfg?.channels?.discord;
    if (!discordCfg)
        return null;
    const effectiveId = accountId ?? discordCfg.defaultAccount;
    const raw = effectiveId
        ? (discordCfg.accounts?.[effectiveId]?.token ?? discordCfg.token)
        : discordCfg.token;
    return typeof raw === "string" ? raw : null;
}
// Fetch the sender's avatar URL from the Discord REST API.
// Returns the CDN URL (animated GIF for animated avatars) or a default colour
// avatar URL when the user has no custom avatar. Returns null on any error.
async function fetchDiscordAvatar(userId, botToken) {
    return new Promise((resolve) => {
        const req = httpsRequest({
            hostname: "discord.com",
            path: `/api/v10/users/${userId}`,
            method: "GET",
            headers: {
                Authorization: `Bot ${botToken}`,
                "User-Agent": "openclaw-bridge/0.1 (+https://github.com/joshmrtn/openclaw-bridge)",
            },
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                try {
                    const user = JSON.parse(data);
                    if (!user?.id) {
                        resolve(null);
                        return;
                    }
                    if (user.avatar) {
                        const ext = user.avatar.startsWith("a_") ? "gif" : "png";
                        resolve(`https://cdn.discordapp.com/avatars/${userId}/${user.avatar}.${ext}?size=128`);
                    }
                    else {
                        // Default avatar: new (pomelo) accounts use snowflake-based index;
                        // legacy accounts with a non-zero discriminator use discriminator % 5.
                        const idx = (user.discriminator && user.discriminator !== "0")
                            ? Number(user.discriminator) % 5
                            : Number(BigInt(userId) >> 22n) % 6;
                        resolve(`https://cdn.discordapp.com/embed/avatars/${idx}.png`);
                    }
                }
                catch {
                    resolve(null);
                }
            });
        });
        req.setTimeout(3000, () => { req.destroy(); resolve(null); });
        req.on("error", () => resolve(null));
        req.end();
    });
}
// ---------------------------------------------------------------------------
// Output formatting (R6)
// ---------------------------------------------------------------------------
// Default strip behaviour: on for Telegram (asterisks are literal), off for Discord (renders as italics).
function shouldStripAsteriskMarkup(channelId, linkEntry) {
    if (linkEntry.formatting?.strip_asterisk_markup !== undefined) {
        return linkEntry.formatting.strip_asterisk_markup;
    }
    const channelType = channelId.split("-")[0];
    return channelType === "telegram";
}
// Guards against ReDoS: long lines skip table classification entirely.
const TABLE_LINE_MAX = 500;
// Returns true for markdown table separator rows (|---|---| or | :--: |).
// Uses a length guard and a negated character class instead of a nested quantifier
// to prevent catastrophic backtracking on adversarial input.
function isTableSeparatorRow(line) {
    if (line.length > TABLE_LINE_MAX)
        return false;
    const t = line.trim();
    if (t.length < 3 || t[0] !== "|" || t[t.length - 1] !== "|")
        return false;
    return !/[^|:\-\s]/.test(t.slice(1, -1));
}
export function shouldFireIdleHeartbeat(state, idleMs, now) {
    return idleMs > 0 && now - state.lastMessageAt >= idleMs && state.idleHeartbeatFiredAt < state.lastMessageAt;
}
// Strip inline and block-level markdown, preserving semantic content. Collapses extra whitespace.
export function formatOutboundText(text, channelId, linkEntry) {
    if (!shouldStripAsteriskMarkup(channelId, linkEntry))
        return text;
    const lines = text.split("\n");
    const processed = lines
        .filter(line => !isTableSeparatorRow(line))
        .map(line => {
        // Table data rows: | foo | bar | → foo | bar
        if (line.length <= TABLE_LINE_MAX && /^\s*\|/.test(line) && /\|\s*$/.test(line.trim())) {
            return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "")
                .split("|").map(c => c.trim()).filter(Boolean).join(" | ");
        }
        // Headers: ## Heading → Heading
        const hMatch = line.match(/^#{1,6}\s+(.*)/);
        if (hMatch)
            return hMatch[1];
        // Blockquotes: > text → text
        const bqMatch = line.match(/^>\s?(.*)/);
        if (bqMatch)
            return bqMatch[1];
        return line;
    });
    return processed
        .join("\n")
        // Markdown links [text](url) → text
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        // Inline markup: **bold**, *italic*, _italic_
        .replace(/\*\*([^*\n]+)\*\*/g, "$1")
        .replace(/\*([^*\n]+)\*/g, "$1")
        .replace(/_([^_\n]+)_/g, "$1")
        .replace(/ {2,}/g, " ")
        .trim();
}
// ---------------------------------------------------------------------------
// Reverse lookup: OC accountId → ST character name.
// event.accountId is the OC Discord/Telegram account name (e.g. "frog", "toad")
// which matches the agentId in our bindings config.
function characterForAccount(accountId) {
    const state = readLinkState();
    for (const [characterName, link] of Object.entries(state)) {
        if (link?.oc_agent_id === accountId && link?.active) {
            return characterName;
        }
    }
    return null;
}
function getToken() {
    const envToken = process.env.OPENCLAW_BRIDGE_AUTH_TOKEN ??
        process.env.OPENCLAW_BRIDGE_TOKEN;
    if (envToken)
        return envToken;
    try {
        return readFileSync(TOKEN_FILE, "utf8").trim();
    }
    catch {
        return "";
    }
}
// ---------------------------------------------------------------------------
// HTTP helpers + CSRF token management
// ---------------------------------------------------------------------------
// Raw GET — returns body, status, and any Set-Cookie headers.
function getJson(url) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = httpRequest({
            hostname: parsed.hostname,
            port: Number(parsed.port) || 80,
            path: parsed.pathname,
            method: "GET",
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                const raw = res.headers["set-cookie"] ?? [];
                const setCookie = Array.isArray(raw) ? raw : [raw];
                try {
                    resolve({ status: res.statusCode ?? 0, body: JSON.parse(data), setCookie });
                }
                catch {
                    resolve({ status: res.statusCode ?? 0, body: data, setCookie });
                }
            });
        });
        req.on("error", reject);
        req.end();
    });
}
// Raw POST — callers supply all headers explicitly.
function postJsonRaw(url, authToken, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(body);
        const parsed = new URL(url);
        const req = httpRequest({
            hostname: parsed.hostname,
            port: Number(parsed.port) || 80,
            path: parsed.pathname,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(bodyStr),
                Authorization: `Bearer ${authToken}`,
                ...extraHeaders,
            },
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                try {
                    resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
                }
                catch {
                    resolve({ status: res.statusCode ?? 0, body: data });
                }
            });
        });
        req.on("error", reject);
        req.write(bodyStr);
        req.end();
    });
}
let csrfCache = null;
async function getCsrfState() {
    if (csrfCache)
        return csrfCache;
    const result = await getJson(`${ST_BASE}/csrf-token`);
    const token = typeof result.body?.token === "string" ? result.body.token : "";
    // Extract name=value from each Set-Cookie entry, stripping Path/HttpOnly/etc attributes.
    const cookie = result.setCookie
        .map((c) => c.split(";")[0].trim())
        .filter(Boolean)
        .join("; ");
    csrfCache = { token, cookie };
    return csrfCache;
}
// Public POST — transparently fetches a CSRF token on first call and caches it.
// Retries once on 403 (session expiry / token rotation) with a fresh token.
async function postJson(url, authToken, body) {
    const csrf = await getCsrfState();
    const csrfHeaders = {
        "x-csrf-token": csrf.token,
        ...(csrf.cookie ? { Cookie: csrf.cookie } : {}),
    };
    const result = await postJsonRaw(url, authToken, body, csrfHeaders);
    if (result.status === 403) {
        // Token stale — refresh and retry once.
        csrfCache = null;
        const fresh = await getCsrfState();
        const freshHeaders = {
            "x-csrf-token": fresh.token,
            ...(fresh.cookie ? { Cookie: fresh.cookie } : {}),
        };
        return postJsonRaw(url, authToken, body, freshHeaders);
    }
    return result;
}
// ---------------------------------------------------------------------------
// Generation retry & failure handling (#223)
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Transient upstream failures worth retrying against ST (vs deterministic
// declines/bugs). 429=rate limit, 502/503/504=gateway/overload/timeout.
export function isTransientGenerateStatus(status) {
    return status === 429 || status === 502 || status === 503 || status === 504;
}
const DEFAULT_BACKOFF_SCHEDULE = [1000, 3000];
// Parses OPENCLAW_BRIDGE_GENERATE_BACKOFF_MS ("1000,3000") into a backoff
// schedule. The number of retries equals the schedule length.
export function parseBackoffSchedule(raw) {
    if (!raw)
        return [...DEFAULT_BACKOFF_SCHEDULE];
    const parsed = raw
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
    return parsed.length > 0 ? parsed : [...DEFAULT_BACKOFF_SCHEDULE];
}
// Runs `post` with bounded retry/backoff. Retries only on transient HTTP
// statuses or thrown network/timeout errors; returns immediately on 200 or a
// deterministic failure. A persistent failure returns the last result (a thrown
// error becomes a synthetic { status: 0 }) so the caller can ALWAYS claim the
// message rather than fall through to the (expensive) OC agent (#223).
export async function generateWithRetry(post, opts) {
    const { schedule, sleep: sleepFn } = opts;
    let last = { status: 0, body: {} };
    for (let attempt = 0; attempt <= schedule.length; attempt++) {
        try {
            const result = await post();
            if (result.status === 200 || !isTransientGenerateStatus(result.status)) {
                return result;
            }
            last = result; // transient — fall through to retry/backoff
        }
        catch (err) {
            last = { status: 0, body: { error: err?.message ?? String(err) } };
        }
        if (attempt < schedule.length) {
            await sleepFn(schedule[attempt]);
        }
    }
    return last;
}
// Builds the "character unavailable" reply OC delivers itself when generation
// fails. Uses the link's fallback_message when configured, else a default.
export function buildUnavailableText(character, status, linkEntry) {
    if (linkEntry.fallback_message)
        return linkEntry.fallback_message;
    const detail = status > 0 ? `error ${status}` : "a connection error";
    return `⚠️ ${character} is unavailable right now (${detail}). Please try again in a moment.`;
}
// Decides what to deliver for an inbound message given the (post-retry) ST
// result. Every outcome is a claim — the OC agent never runs a generation for a
// linked character; it is only ever activated when the ST character chooses to
// perform an action (#223).
export function decideInboundDelivery(result, character, linkEntry) {
    if (result.status === 200) {
        const response = typeof result.body?.response === "string" ? result.body.response : "";
        return response.length > 0 ? { kind: "reply", text: response } : { kind: "silent" };
    }
    return { kind: "unavailable", text: buildUnavailableText(character, result.status, linkEntry) };
}
// ---------------------------------------------------------------------------
// Heartbeat execution (R10)
// ---------------------------------------------------------------------------
export function withTimeout(ms, label, promise) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            console.warn(`[openclaw-bridge] ${label} timed out after ${ms}ms`);
            reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
        promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
}
async function runHeartbeat(character, link, trigger, api) {
    if (runningHeartbeats.has(character))
        return;
    runningHeartbeats.add(character);
    const hb = link.heartbeat;
    const token = getToken();
    const channelId = hb.channel_id;
    const defaultPrompt = trigger === "idle"
        ? "The channel has been quiet for a while. You may reach out if you feel inspired, or return an empty response to remain quiet."
        : "Some time has passed. Post to your channel if you have something to say, or return an empty response to stay quiet.";
    const prompt = hb.prompt ?? defaultPrompt;
    console.log(`[openclaw-bridge] Heartbeat trigger=${trigger} character=${character} channel=${channelId}`);
    try {
        const result = await withTimeout(HEARTBEAT_TIMEOUT_MS, `heartbeat(${character})`, postJson(`${ST_BASE}/api/plugins/openclaw-bridge/generate`, token, {
            character,
            message: prompt,
            user_id: "heartbeat:system",
            is_heartbeat: true,
            channel: channelId || null,
        }));
        if (result.status !== 200) {
            console.warn(`[openclaw-bridge] Heartbeat ST returned ${result.status} for ${character}: ${JSON.stringify(result.body)}`);
            return;
        }
        const responseText = result.body?.response ?? "";
        if (!responseText) {
            // R10.4: empty response → stay quiet, no channel post
            console.log(`[openclaw-bridge] Heartbeat quiet response for ${character} — staying quiet`);
            return;
        }
        // Post response to channel
        try {
            const adapter = await api.runtime.channel.outbound.loadAdapter(channelId);
            if (!adapter?.sendText) {
                console.warn(`[openclaw-bridge] Heartbeat: no outbound adapter for ${channelId}`);
            }
            else {
                await adapter.sendText({
                    cfg: api.config,
                    to: hb.target ?? "",
                    text: formatOutboundText(responseText, channelId, link),
                    ...(hb.account_id ? { accountId: hb.account_id } : {}),
                });
            }
        }
        catch (postErr) {
            console.error(`[openclaw-bridge] Heartbeat channel post failed: ${postErr.message}`);
        }
        // Execute character actions (R10.3: heartbeat = autonomous = owner-level for actions)
        const actions = Array.isArray(result.body?.actions) ? result.body.actions : [];
        if (actions.length > 0) {
            const ctx = { channelId, accountId: hb.account_id ?? null };
            await executeCharacterActions(actions, character, token, api, ctx, link);
        }
    }
    finally {
        runningHeartbeats.delete(character);
    }
}
// ---------------------------------------------------------------------------
// Outbound action execution
// ---------------------------------------------------------------------------
async function executeCharacterActions(actions, character, token, api, ctx, linkEntry) {
    for (const action of actions) {
        let outcome = "ok";
        try {
            switch (action.type) {
                case "send_message": {
                    const channelId = String(action.channel_id ?? ctx.channelId);
                    const adapter = await api.runtime.channel.outbound.loadAdapter(channelId);
                    if (!adapter?.sendText) {
                        outcome = "no outbound adapter";
                        break;
                    }
                    const to = action.recipient ? String(action.recipient) : String(action.target ?? "");
                    await adapter.sendText({
                        cfg: api.config,
                        to,
                        text: formatOutboundText(String(action.content ?? ""), channelId, linkEntry),
                        ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
                    });
                    outcome = "sent";
                    break;
                }
                case "file_write": {
                    const workspace = resolve(homedir(), ".openclaw", "characters", character, "workspace");
                    const target = resolve(workspace, String(action.path ?? ""));
                    if (!target.startsWith(workspace + "/") && target !== workspace) {
                        console.warn(`[openclaw-bridge] file_write blocked: path escapes workspace (${target})`);
                        outcome = "blocked";
                        break;
                    }
                    await mkdir(resolve(target, ".."), { recursive: true });
                    await writeFile(target, String(action.content ?? ""), "utf8");
                    outcome = "written";
                    break;
                }
                default:
                    console.warn(`[openclaw-bridge] Unknown action type: ${action.type}`);
                    outcome = "unknown_type";
            }
        }
        catch (err) {
            console.error(`[openclaw-bridge] Action execution failed (${action.type}): ${err.message}`);
            outcome = `error: ${err.message}`;
        }
        // R5.5: confirm action outcome back to ST chat history
        try {
            await postJson(`${ST_BASE}/api/plugins/openclaw-bridge/log-action`, token, {
                character,
                action_description: `${action.type} (${outcome})${action.content ? `: ${String(action.content).substring(0, 200)}` : ""}`,
            });
        }
        catch (logErr) {
            console.warn(`[openclaw-bridge] Failed to log action outcome: ${logErr.message}`);
        }
    }
}
// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------
export default definePluginEntry({
    id: "openclaw-bridge",
    name: "OpenClaw Bridge",
    description: "Routes inbound messages to SillyTavern for character generation, bypassing the OC agent LLM",
    register(api) {
        // message_received fires for EVERY inbound message (including first contact)
        // and BEFORE before_dispatch, carrying the display name at
        // event.metadata.senderName. We cache it here so before_dispatch can attach
        // user_name to the /generate POST. (inbound_claim is unusable for this: OC only
        // fires it for conversations already bound to the plugin, so it never runs on
        // first contact — that was the "ExternalChat" bug, #224.) We also kick off an
        // async Discord avatar fetch that resolves within the generation window.
        api.on("message_received", (event, ctx) => {
            const senderId = ctx.senderId ?? event.senderId;
            const channelId = ctx.channelId ?? event.channel;
            if (!senderId || !channelId)
                return;
            const accountId = ctx.accountId;
            if (!characterForAccount(accountId ?? ""))
                return; // only cache for our characters
            if (senderCache.size > 500)
                pruneExpiredSenderCache();
            const key = cacheSender(channelId, senderId, extractSenderName(event));
            if (!key)
                return;
            // Kick off an async Discord avatar fetch. It resolves well within
            // the ST generation window (Discord API ≈ 100-500ms; generation ≥ 5s).
            const channelType = channelId.split("-")[0];
            if (channelType === "discord") {
                const token = resolveDiscordToken(api.config, accountId);
                if (token) {
                    fetchDiscordAvatar(senderId, token).then(avatarUrl => {
                        const e = senderCache.get(key);
                        if (e)
                            e.avatarUrl = avatarUrl;
                    }).catch(() => { });
                }
            }
        });
        // before_dispatch fires before the message is dispatched to the agent.
        // Returning { handled: true, text } delivers the text as the reply and
        // prevents the OC agent LLM from running at all.
        // Returning void = don't intercept; agent routing proceeds normally.
        api.on("before_dispatch", async (event, ctx) => {
            const accountId = ctx.accountId;
            if (!accountId)
                return;
            const character = characterForAccount(accountId);
            if (!character)
                return; // No active ST link for this account — don't intercept
            // Track last message time for idle heartbeat detection (R10.7)
            getOrCreateHeartbeatState(character).lastMessageAt = Date.now();
            const linkEntry = readLinkState()[character] ?? { oc_agent_id: accountId, active: true, owner_user_ids: [] };
            const messageText = (event.content ?? event.text ?? '').trim();
            if (!messageText)
                return;
            // Let OC handle its own slash commands (/new, /reset, etc.)
            if (messageText.startsWith("/"))
                return;
            // Build platform-prefixed user ID for trust label injection,
            // e.g. "discord:123456789"
            const senderId = ctx.senderId ?? event.senderId;
            const channelType = (ctx.channelId ?? event.channel ?? "").split("-")[0] || "unknown";
            const userId = senderId ? `${channelType}:${senderId}` : null;
            // Resolve cached sender name and avatar (populated by message_received hook)
            const senderEntry = lookupSender(ctx.channelId, senderId);
            const resolvedUserName = senderEntry?.name ?? null;
            const resolvedUserAvatar = senderEntry?.avatarUrl ?? null;
            // Record which source resolved the name so we can measure fall-through to
            // the ST "<Channel> user <id>" safety net (#224).
            console.log(`[openclaw-bridge] sender-name source=${resolvedUserName ? "cache" : "none"} character=${character} userId=${userId ?? "unknown"}`);
            const token = getToken();
            if (!token) {
                console.error("[openclaw-bridge] No auth token configured — cannot intercept message");
                return;
            }
            console.log(`[openclaw-bridge] Intercepting message — account=${accountId} character=${character} userId=${userId ?? "unknown"}`);
            const channelId = ctx.channelId ?? "";
            // Self-message guard: drop messages where the sender is our own bot account.
            // Real channel platforms filter this at the SDK level (Discord does not echo
            // bot messages back to the bot; OC adapters check senderId === botUserId).
            // This guard is defense-in-depth for platforms or edge cases where that
            // filtering is absent. Without it, a send_message action could arrive back
            // as an inbound message and trigger an infinite generation loop.
            const chanCfgs = (api.config?.channels ?? {});
            const chanCfg = chanCfgs[channelId] ?? chanCfgs[channelType] ?? {};
            const botUserId = typeof chanCfg.botUserId === "string" ? chanCfg.botUserId : null;
            if (botUserId && senderId === botUserId) {
                console.log(`[openclaw-bridge] Self-message from bot account ${senderId} — dropping to prevent loop`);
                return { handled: true, text: "" };
            }
            // Generate with bounded retry/backoff on transient failures. The OC
            // agent must NEVER run a generation for a linked character — a transient
            // upstream 503 used to fall through to a full (expensive) agent turn and
            // burn quota. Every outcome below claims the message (#223).
            const schedule = parseBackoffSchedule(process.env.OPENCLAW_BRIDGE_GENERATE_BACKOFF_MS);
            const result = await generateWithRetry(() => postJson(`${ST_BASE}/api/plugins/openclaw-bridge/generate`, token, {
                character,
                message: messageText,
                user_id: userId,
                ...(resolvedUserName ? { user_name: resolvedUserName } : {}),
                ...(resolvedUserAvatar ? { user_avatar: resolvedUserAvatar } : {}),
                channel: channelId || null,
                ...(linkEntry.timeout_ms ? { timeout_ms: linkEntry.timeout_ms } : {}),
            }), { schedule, sleep });
            const delivery = decideInboundDelivery(result, character, linkEntry);
            if (delivery.kind === "reply") {
                console.log(`[openclaw-bridge] ST responded (${delivery.text.length} chars) — delivering synthetic reply`);
                // R5.1: execute any actions the character requested during generation
                const actions = Array.isArray(result.body?.actions) ? result.body.actions : [];
                if (actions.length > 0) {
                    console.log(`[openclaw-bridge] Executing ${actions.length} character action(s)`);
                    await executeCharacterActions(actions, character, token, api, ctx, linkEntry);
                }
                return { handled: true, text: formatOutboundText(delivery.text, channelId, linkEntry) };
            }
            if (delivery.kind === "silent") {
                // Empty 200 shouldn't happen — it smells of an ST/link misconfig
                // (model not set up, character not linked). Claim and stay silent
                // rather than emit a confusing "no text" message or run the agent.
                console.warn(`[openclaw-bridge] ST returned an empty 200 response for ${character} — claiming and staying silent (possible ST/link misconfig)`);
                return { handled: true, text: "" };
            }
            // delivery.kind === "unavailable": generation failed after retries.
            // Deliver our own "unavailable" reply and claim — never invoke the agent.
            console.warn(`[openclaw-bridge] ST generation failed for ${character} (status ${result.status}) after retries — delivering unavailable reply, NOT invoking agent`);
            try {
                await postJson(`${ST_BASE}/api/plugins/openclaw-bridge/log-action`, token, {
                    character,
                    action_description: `Generation failed (status ${result.status}) — unavailable reply sent`,
                    channel: channelId || null,
                });
            }
            catch (logErr) {
                console.warn(`[openclaw-bridge] Failed to log unavailable notice to history: ${logErr.message}`);
            }
            return { handled: true, text: formatOutboundText(delivery.text, channelId, linkEntry) };
        });
        // R10: heartbeat polling loop (interval configurable via OPENCLAW_BRIDGE_HEARTBEAT_LOOP_MS)
        const heartbeatLoopMs = parseInt(process.env.OPENCLAW_BRIDGE_HEARTBEAT_LOOP_MS || "60000", 10);
        heartbeatTimer = setInterval(async () => {
            const state = readLinkState();
            for (const [character, link] of Object.entries(state)) {
                if (!link?.active || !link?.heartbeat?.enabled || !link.heartbeat.channel_id)
                    continue;
                if (runningHeartbeats.has(character))
                    continue;
                const hb = link.heartbeat;
                const intervalMs = hb.interval_ms ?? 7200000;
                const idleMs = hb.idle_threshold_ms ?? 7200000;
                const now = Date.now();
                const s = getOrCreateHeartbeatState(character);
                // Scheduled heartbeat (R10.1): fire when interval has elapsed
                if (now - s.lastHeartbeatAt >= intervalMs) {
                    s.lastHeartbeatAt = now;
                    runHeartbeat(character, link, "scheduled", api).catch(err => {
                        console.error(`[openclaw-bridge] Heartbeat error for ${character}: ${err.message}`);
                    });
                    continue;
                }
                // Idle detection (R10.7): fire once when channel has been quiet too long
                if (shouldFireIdleHeartbeat(s, idleMs, now)) {
                    s.idleHeartbeatFiredAt = now;
                    s.lastHeartbeatAt = now;
                    runHeartbeat(character, link, "idle", api).catch(err => {
                        console.error(`[openclaw-bridge] Idle heartbeat error for ${character}: ${err.message}`);
                    });
                }
            }
        }, heartbeatLoopMs);
        // Unref so the timer doesn't prevent clean process exit
        if (heartbeatTimer.unref)
            heartbeatTimer.unref();
        // Cleanup on gateway stop
        api.on("gateway_stop", () => {
            if (heartbeatTimer) {
                clearInterval(heartbeatTimer);
                heartbeatTimer = null;
            }
            heartbeatState.clear();
            runningHeartbeats.clear();
        });
    },
});
