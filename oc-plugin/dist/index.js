import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const OC_BRIDGE_DATA = process.env.OPENCLAW_BRIDGE_DATA_DIR ??
    resolve(homedir(), ".openclaw", "openclaw-bridge");
const LINKS_FILE = process.env.OPENCLAW_BRIDGE_LINKS_PATH ??
    resolve(OC_BRIDGE_DATA, "character-links.json");
const TOKEN_FILE = resolve(OC_BRIDGE_DATA, "bridge-token.txt");
// ST_BASE must be http (not https) and must point at the host running ST.
// OPENCLAW_BRIDGE_URL is intentionally NOT used here — that variable is for
// the character-bridge skill and may be https or lack the plugin path prefix.
const ST_BASE = process.env.OPENCLAW_BRIDGE_ST_URL ?? "http://127.0.0.1:8000";
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
function postJson(url, token, body) {
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
                Authorization: `Bearer ${token}`,
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
// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------
export default definePluginEntry({
    id: "openclaw-bridge",
    name: "OpenClaw Bridge",
    description: "Routes inbound messages to SillyTavern for character generation, bypassing the OC agent LLM",
    register(api) {
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
            if (!event.content)
                return;
            // Let OC handle its own slash commands (/new, /reset, etc.)
            if (event.content.trim().startsWith("/"))
                return;
            // Build platform-prefixed user ID for trust label injection,
            // e.g. "discord:123456789"
            const senderId = ctx.senderId ?? event.senderId;
            const channelType = (ctx.channelId ?? event.channel ?? "").split("-")[0] || "unknown";
            const userId = senderId ? `${channelType}:${senderId}` : null;
            const token = getToken();
            if (!token) {
                console.error("[openclaw-bridge] No auth token configured — cannot intercept message");
                return;
            }
            console.log(`[openclaw-bridge] Intercepting message — account=${accountId} character=${character} userId=${userId ?? "unknown"}`);
            try {
                const result = await postJson(`${ST_BASE}/api/plugins/openclaw-bridge/generate`, token, {
                    character,
                    message: event.content,
                    user_id: userId,
                    channel: ctx.channelId ?? null,
                });
                if (result.status === 200 && typeof result.body?.response === "string" && result.body.response.length > 0) {
                    console.log(`[openclaw-bridge] ST responded (${result.body.response.length} chars) — delivering synthetic reply`);
                    return {
                        handled: true,
                        text: result.body.response,
                    };
                }
                if (result.status === 200 && result.body?.response?.length === 0) {
                    console.warn("[openclaw-bridge] ST returned empty response — not claiming, agent will handle");
                    return;
                }
                console.warn(`[openclaw-bridge] ST returned ${result.status} — not intercepting, agent will handle with skill`);
            }
            catch (err) {
                console.error(`[openclaw-bridge] ST request failed (${err.message}) — not intercepting, agent will handle with skill`);
            }
            // Returning undefined = don't intercept; agent routing proceeds normally
        });
    },
});
