import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
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
const OC_BRIDGE_DATA =
    process.env.OPENCLAW_BRIDGE_DATA_DIR ??
    resolve(homedir(), ".openclaw", "openclaw-bridge");

const LINKS_FILE =
    process.env.OPENCLAW_BRIDGE_LINKS_PATH ??
    resolve(OC_BRIDGE_DATA, "character-links.json");

const TOKEN_FILE = resolve(OC_BRIDGE_DATA, "bridge-token.txt");

// ST_BASE must be http (not https) and must point at the host running ST.
// OPENCLAW_BRIDGE_URL is intentionally NOT used here — that variable is for
// the character-bridge skill and may be https or lack the plugin path prefix.
const ST_BASE =
    process.env.OPENCLAW_BRIDGE_ST_URL ?? "http://127.0.0.1:8000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LinkEntry = {
    oc_agent_id: string;
    active: boolean;
    owner_user_ids: string[];
    formatting?: {
        strip_asterisk_markup?: boolean;
    };
    timeout_ms?: number;
    fallback_message?: string;
};

function readLinkState(): Record<string, LinkEntry> {
    try {
        const raw = readFileSync(LINKS_FILE, "utf8");
        const parsed = JSON.parse(raw || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    } catch {
        return {};
    }
}

// ---------------------------------------------------------------------------
// Sender info cache (R31)
// Populated by the inbound_claim hook (which provides senderName), consumed in
// before_dispatch so name + avatar are ready when we POST to /generate.
// ---------------------------------------------------------------------------

type SenderInfo = { name: string | null; avatarUrl: string | null; cachedAt: number };
const senderCache = new Map<string, SenderInfo>();
const SENDER_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function senderCacheKey(channelId: string, senderId: string): string {
    return `${channelId}\x00${senderId}`;
}

function pruneExpiredSenderCache(): void {
    const now = Date.now();
    for (const [key, entry] of senderCache) {
        if (now - entry.cachedAt > SENDER_CACHE_TTL_MS) senderCache.delete(key);
    }
}

// Read the Discord bot token from the OC config for the given account.
// Returns null if no plain-string token is found (SecretRef values cannot be
// resolved without the OC secrets runtime).
function resolveDiscordToken(cfg: any, accountId?: string | null): string | null {
    const discordCfg = cfg?.channels?.discord;
    if (!discordCfg) return null;
    const effectiveId = accountId ?? discordCfg.defaultAccount;
    const raw = effectiveId
        ? (discordCfg.accounts?.[effectiveId]?.token ?? discordCfg.token)
        : discordCfg.token;
    return typeof raw === "string" ? raw : null;
}

// Fetch the sender's avatar URL from the Discord REST API.
// Returns the CDN URL (animated GIF for animated avatars) or a default colour
// avatar URL when the user has no custom avatar. Returns null on any error.
async function fetchDiscordAvatar(userId: string, botToken: string): Promise<string | null> {
    return new Promise((resolve) => {
        const req = httpsRequest(
            {
                hostname: "discord.com",
                path: `/api/v10/users/${userId}`,
                method: "GET",
                headers: {
                    Authorization: `Bot ${botToken}`,
                    "User-Agent": "openclaw-bridge/0.1 (+https://github.com/joshmrtn/openclaw-bridge)",
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk: string) => (data += chunk));
                res.on("end", () => {
                    try {
                        const user = JSON.parse(data);
                        if (!user?.id) { resolve(null); return; }
                        if (user.avatar) {
                            const ext = user.avatar.startsWith("a_") ? "gif" : "png";
                            resolve(`https://cdn.discordapp.com/avatars/${userId}/${user.avatar}.${ext}?size=128`);
                        } else {
                            // Default avatar: new (pomelo) accounts use snowflake-based index;
                            // legacy accounts with a non-zero discriminator use discriminator % 5.
                            const idx = (user.discriminator && user.discriminator !== "0")
                                ? Number(user.discriminator) % 5
                                : Number(BigInt(userId) >> 22n) % 6;
                            resolve(`https://cdn.discordapp.com/embed/avatars/${idx}.png`);
                        }
                    } catch { resolve(null); }
                });
            }
        );
        req.setTimeout(3000, () => { req.destroy(); resolve(null); });
        req.on("error", () => resolve(null));
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Output formatting (R6)
// ---------------------------------------------------------------------------

// Default strip behaviour: on for Telegram (asterisks are literal), off for Discord (renders as italics).
function shouldStripAsteriskMarkup(channelId: string, linkEntry: LinkEntry): boolean {
    if (linkEntry.formatting?.strip_asterisk_markup !== undefined) {
        return linkEntry.formatting.strip_asterisk_markup;
    }
    const channelType = channelId.split("-")[0];
    return channelType === "telegram";
}

// Strip inline and block-level markdown, preserving semantic content. Collapses extra whitespace.
export function formatOutboundText(text: string, channelId: string, linkEntry: LinkEntry): string {
    if (!shouldStripAsteriskMarkup(channelId, linkEntry)) return text;

    const lines = text.split("\n");
    const processed = lines
        // Remove table separator rows (lines containing only |, -, :, and spaces)
        .filter(line => !/^\s*\|[-:\s|]+\|\s*$/.test(line))
        .map(line => {
            // Table data rows: | foo | bar | → foo | bar
            if (/^\s*\|/.test(line) && /\|\s*$/.test(line.trim())) {
                return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "")
                    .split("|").map(c => c.trim()).filter(Boolean).join(" | ");
            }
            // Headers: ## Heading → Heading
            const hMatch = line.match(/^#{1,6}\s+(.*)/);
            if (hMatch) return hMatch[1];
            // Blockquotes: > text → text
            const bqMatch = line.match(/^>\s?(.*)/);
            if (bqMatch) return bqMatch[1];
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
function characterForAccount(accountId: string): string | null {
    const state = readLinkState();
    for (const [characterName, link] of Object.entries(state)) {
        if (link?.oc_agent_id === accountId && link?.active) {
            return characterName;
        }
    }
    return null;
}

function getToken(): string {
    const envToken =
        process.env.OPENCLAW_BRIDGE_AUTH_TOKEN ??
        process.env.OPENCLAW_BRIDGE_TOKEN;
    if (envToken) return envToken;
    try {
        return readFileSync(TOKEN_FILE, "utf8").trim();
    } catch {
        return "";
    }
}

// ---------------------------------------------------------------------------
// HTTP helpers + CSRF token management
// ---------------------------------------------------------------------------

// Raw GET — returns body, status, and any Set-Cookie headers.
function getJson(url: string): Promise<{ status: number; body: any; setCookie: string[] }> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = httpRequest(
            {
                hostname: parsed.hostname,
                port: Number(parsed.port) || 80,
                path: parsed.pathname,
                method: "GET",
            },
            (res) => {
                let data = "";
                res.on("data", (chunk: string) => (data += chunk));
                res.on("end", () => {
                    const raw = res.headers["set-cookie"] ?? [];
                    const setCookie = Array.isArray(raw) ? raw : [raw];
                    try {
                        resolve({ status: res.statusCode ?? 0, body: JSON.parse(data), setCookie });
                    } catch {
                        resolve({ status: res.statusCode ?? 0, body: data, setCookie });
                    }
                });
            }
        );
        req.on("error", reject);
        req.end();
    });
}

// Raw POST — callers supply all headers explicitly.
function postJsonRaw(
    url: string,
    authToken: string,
    body: object,
    extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(body);
        const parsed = new URL(url);
        const req = httpRequest(
            {
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
            },
            (res) => {
                let data = "";
                res.on("data", (chunk: string) => (data += chunk));
                res.on("end", () => {
                    try {
                        resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
                    } catch {
                        resolve({ status: res.statusCode ?? 0, body: data });
                    }
                });
            }
        );
        req.on("error", reject);
        req.write(bodyStr);
        req.end();
    });
}

// CSRF token cache. Populated on first use, cleared on 403 so the next call
// fetches a fresh token. Works when CSRF is enabled (fetches real token) and
// when disabled (ST returns {token:"disabled"} with no cookie — the header is
// sent but ignored by ST's middleware).
type CsrfState = { token: string; cookie: string };
let csrfCache: CsrfState | null = null;

async function getCsrfState(): Promise<CsrfState> {
    if (csrfCache) return csrfCache;
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
async function postJson(
    url: string,
    authToken: string,
    body: object
): Promise<{ status: number; body: any }> {
    const csrf = await getCsrfState();
    const csrfHeaders: Record<string, string> = {
        "x-csrf-token": csrf.token,
        ...(csrf.cookie ? { Cookie: csrf.cookie } : {}),
    };

    const result = await postJsonRaw(url, authToken, body, csrfHeaders);

    if (result.status === 403) {
        // Token stale — refresh and retry once.
        csrfCache = null;
        const fresh = await getCsrfState();
        const freshHeaders: Record<string, string> = {
            "x-csrf-token": fresh.token,
            ...(fresh.cookie ? { Cookie: fresh.cookie } : {}),
        };
        return postJsonRaw(url, authToken, body, freshHeaders);
    }

    return result;
}

// ---------------------------------------------------------------------------
// Outbound action execution
// ---------------------------------------------------------------------------

async function executeCharacterActions(
    actions: any[],
    character: string,
    token: string,
    api: any,
    ctx: any,
    linkEntry: LinkEntry,
): Promise<void> {
    for (const action of actions) {
        let outcome = "ok";

        try {
            switch (action.type) {
                case "discord_post": {
                    const adapter = await api.runtime.channel.outbound.loadAdapter(ctx.channelId);
                    if (!adapter?.sendText) {
                        outcome = "no outbound adapter";
                        break;
                    }
                    await adapter.sendText({
                        cfg: api.config,
                        to: String(action.channel_id ?? ""),
                        text: formatOutboundText(String(action.content ?? ""), ctx.channelId, linkEntry),
                        ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
                    });
                    outcome = "sent";
                    break;
                }
                case "discord_dm": {
                    const adapter = await api.runtime.channel.outbound.loadAdapter(ctx.channelId);
                    if (!adapter?.sendText) {
                        outcome = "no outbound adapter";
                        break;
                    }
                    await adapter.sendText({
                        cfg: api.config,
                        to: String(action.user_id ?? ""),
                        text: formatOutboundText(String(action.content ?? ""), ctx.channelId, linkEntry),
                        ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
                    });
                    outcome = "sent";
                    break;
                }
                case "telegram_post": {
                    const adapter = await api.runtime.channel.outbound.loadAdapter(ctx.channelId);
                    if (!adapter?.sendText) {
                        outcome = "no outbound adapter";
                        break;
                    }
                    await adapter.sendText({
                        cfg: api.config,
                        to: String(action.channel_id ?? ""),
                        text: formatOutboundText(String(action.content ?? ""), ctx.channelId, linkEntry),
                        ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
                    });
                    outcome = "sent";
                    break;
                }
                case "file_write": {
                    await writeFile(String(action.path), String(action.content ?? ""), "utf8");
                    outcome = "written";
                    break;
                }
                default:
                    console.warn(`[openclaw-bridge] Unknown action type: ${action.type}`);
                    outcome = "unknown_type";
            }
        } catch (err: any) {
            console.error(`[openclaw-bridge] Action execution failed (${action.type}): ${err.message}`);
            outcome = `error: ${err.message}`;
        }

        // R5.5: confirm action outcome back to ST chat history
        try {
            await postJson(`${ST_BASE}/api/plugins/openclaw-bridge/log-action`, token, {
                character,
                action_description: `${action.type} (${outcome})${action.content ? `: ${String(action.content).substring(0, 200)}` : ""}`,
            });
        } catch (logErr: any) {
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
        // inbound_claim fires when a message arrives and is claimed by an agent.
        // It provides senderName — not available in before_dispatch — so we cache
        // it here and fire an async Discord avatar fetch that resolves long before
        // the ST generation cycle completes.
        api.on("inbound_claim", (event: any, ctx: any) => {
            const senderId: string | undefined = event.senderId ?? ctx.senderId;
            const channelId: string | undefined = event.channel ?? ctx.channelId;
            if (!senderId || !channelId) return;

            const accountId: string | undefined = ctx.accountId;
            if (!characterForAccount(accountId ?? "")) return; // only cache for our characters

            if (senderCache.size > 500) pruneExpiredSenderCache();

            const key = senderCacheKey(channelId, senderId);
            const existing = senderCache.get(key);
            if (existing && Date.now() - existing.cachedAt < SENDER_CACHE_TTL_MS) {
                existing.cachedAt = Date.now();
                return;
            }

            const entry: SenderInfo = {
                name: event.senderName ?? null,
                avatarUrl: existing?.avatarUrl ?? null, // preserve cached avatar on name refresh
                cachedAt: Date.now(),
            };
            senderCache.set(key, entry);

            // Kick off an async Discord avatar fetch. It resolves well within
            // the ST generation window (Discord API ≈ 100-500ms; generation ≥ 5s).
            const channelType = channelId.split("-")[0];
            if (channelType === "discord") {
                const token = resolveDiscordToken(api.config, accountId);
                if (token) {
                    fetchDiscordAvatar(senderId, token).then(avatarUrl => {
                        const e = senderCache.get(key);
                        if (e) e.avatarUrl = avatarUrl;
                    }).catch(() => {});
                }
            }
        });

        // before_dispatch fires before the message is dispatched to the agent.
        // Returning { handled: true, text } delivers the text as the reply and
        // prevents the OC agent LLM from running at all.
        // Returning void = don't intercept; agent routing proceeds normally.
        api.on("before_dispatch", async (event: any, ctx: any) => {
            const accountId = ctx.accountId;
            if (!accountId) return;

            const character = characterForAccount(accountId);
            if (!character) return; // No active ST link for this account — don't intercept

            const linkEntry: LinkEntry = readLinkState()[character] ?? { oc_agent_id: accountId, active: true, owner_user_ids: [] };

            if (!event.content) return;

            // Let OC handle its own slash commands (/new, /reset, etc.)
            if (event.content.trim().startsWith("/")) return;

            // Build platform-prefixed user ID for trust label injection,
            // e.g. "discord:123456789"
            const senderId = ctx.senderId ?? event.senderId;
            const channelType = (ctx.channelId ?? event.channel ?? "").split("-")[0] || "unknown";
            const userId = senderId ? `${channelType}:${senderId}` : null;

            // Resolve cached sender name and avatar (populated by inbound_claim hook)
            const _cid = ctx.channelId ?? "";
            const senderEntry = (senderId && _cid)
                ? senderCache.get(senderCacheKey(_cid, senderId)) ?? null
                : null;
            const resolvedUserName = senderEntry?.name ?? null;
            const resolvedUserAvatar = senderEntry?.avatarUrl ?? null;

            const token = getToken();
            if (!token) {
                console.error("[openclaw-bridge] No auth token configured — cannot intercept message");
                return;
            }

            console.log(
                `[openclaw-bridge] Intercepting message — account=${accountId} character=${character} userId=${userId ?? "unknown"}`
            );

            const channelId: string = ctx.channelId ?? "";

            const deliverFallback = async (reason: string): Promise<{ handled: true; text: string } | undefined> => {
                const msg = linkEntry.fallback_message;
                if (!msg) return undefined;
                console.log(`[openclaw-bridge] ${reason} — delivering fallback message for ${character}`);
                try {
                    await postJson(`${ST_BASE}/api/plugins/openclaw-bridge/log-action`, token, {
                        character,
                        action_description: `Generation failed (${reason}) — fallback message sent`,
                        channel: channelId || null,
                    });
                } catch (logErr: any) {
                    console.warn(`[openclaw-bridge] Failed to log fallback to history: ${logErr.message}`);
                }
                return { handled: true, text: formatOutboundText(msg, channelId, linkEntry) };
            };

            try {
                const result = await postJson(
                    `${ST_BASE}/api/plugins/openclaw-bridge/generate`,
                    token,
                    {
                        character,
                        message: event.content,
                        user_id: userId,
                        ...(resolvedUserName ? { user_name: resolvedUserName } : {}),
                        ...(resolvedUserAvatar ? { user_avatar: resolvedUserAvatar } : {}),
                        channel: channelId || null,
                        ...(linkEntry.timeout_ms ? { timeout_ms: linkEntry.timeout_ms } : {}),
                    }
                );

                if (result.status === 200 && typeof result.body?.response === "string" && result.body.response.length > 0) {
                    console.log(
                        `[openclaw-bridge] ST responded (${result.body.response.length} chars) — delivering synthetic reply`
                    );

                    // R5.1: execute any actions the character requested during generation
                    const actions: any[] = Array.isArray(result.body.actions) ? result.body.actions : [];
                    if (actions.length > 0) {
                        console.log(`[openclaw-bridge] Executing ${actions.length} character action(s)`);
                        await executeCharacterActions(actions, character, token, api, ctx, linkEntry);
                    }

                    return {
                        handled: true,
                        text: formatOutboundText(result.body.response, channelId, linkEntry),
                    };
                }

                if (result.status === 200 && result.body?.response?.length === 0) {
                    console.warn("[openclaw-bridge] ST returned empty response — not claiming, agent will handle");
                    return;
                }

                console.warn(
                    `[openclaw-bridge] ST returned ${result.status} — not intercepting, agent will handle with skill`
                );
                return await deliverFallback(`ST returned ${result.status}`);
            } catch (err: any) {
                console.error(
                    `[openclaw-bridge] ST request failed (${err.message}) — not intercepting, agent will handle with skill`
                );
                return await deliverFallback(err.message);
            }
        });
    },
});
