# Adding a character

This guide walks through linking a SillyTavern character to an OpenClaw agent so it can receive and respond to messages on Discord, Telegram, or any other OC channel.

Complete [Getting started](getting-started.md) before following this guide.

---

## Step 1 — Create the OC agent

```bash
openclaw agents add {agentname} --workspace ~/.openclaw/workspace-{agentname}
```

Use the character's name in lowercase, e.g. `frog` for "Frog".

---

## Step 2 — Install the character-bridge skill

```bash
cp -r /path/to/openclaw-bridge/skills/character-bridge \
  ~/.openclaw/workspace-{agentname}/skills/
```

---

## Step 3 — Configure the agent

Add an entry to `~/.openclaw/openclaw.json` under `agents.list`:

```json
{
  "id": "{agentname}",
  "name": "{Character Display Name}",
  "workspace": "~/.openclaw/workspace-{agentname}",
  "skills": ["character-bridge"],
  "tools": {
    "profile": "minimal",
    "allow": ["read", "write"]
  },
  "env": {
    "OPENCLAW_BRIDGE_URL": "http://localhost:8000",
    "OPENCLAW_BRIDGE_TOKEN": "{token}"
  }
}
```

Replace `{agentname}`, `{Character Display Name}`, and `{token}` with real values. The token is in `data/openclaw-bridge/bridge-token.txt`.

`profile: "minimal"` gives the agent only `session_status` as its base tool set, structurally denying exec, cron, browser, gateway, and calendar tools at the config layer. `allow: ["read", "write"]` then grants workspace file access needed for character memory. See [OpenClaw security](oc-security.md) for a full explanation of why this matters.

---

## Step 4 — Link the character in SillyTavern

```bash
./scripts/link-character.sh \
  --character "{STCharacterName}" \
  --agent "{agentname}" \
  --owner "{platform}:{ownerUserId}"
```

- `--character` must match the ST character name exactly (case-sensitive)
- `--agent` is the OC agent ID from Step 1
- `--owner` sets a trusted owner ID in `platform:id` format, e.g. `discord:123456789012345678` — repeat for multiple owners; owner messages receive `[OWNER]` trust, all others receive `[GUEST]`

Or use curl directly:

```bash
TOKEN=$(cat data/openclaw-bridge/bridge-token.txt)
curl -X POST http://localhost:8000/api/plugins/openclaw-bridge/characters/{STCharacterName}/link \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "oc_agent_id": "{agentname}",
    "owner_user_ids": ["{platform}:{ownerUserId}"]
  }'
```

---

## Step 5 — Bind the agent to a channel

Follow OC's documentation for your platform (Discord, Telegram, etc.) to connect the agent to a bot account or channel.

---

## Step 6 — Restart OC and verify

```bash
# Apply config changes
openclaw gateway restart

# Confirm the skill loaded
openclaw skills list --agent {agentname}
# Expected: character-bridge appears in the list

# Run the pipeline verification script
./scripts/verify.sh --character "{STCharacterName}"
```

---

## Heartbeat / Autonomous presence

A character can post on a schedule or when a conversation goes quiet, without waiting for a user to send a message. Two triggers are available:

- **Scheduled**: fires every `interval_ms` milliseconds (default: 2 hours)
- **Idle**: fires once when no messages have arrived for `idle_threshold_ms` milliseconds (default: 2 hours), then resets after the next incoming message

Both triggers run inside the OC plugin's 60-second polling loop.

### Enable heartbeat

```bash
./scripts/link-character.sh \
  --character "Frog" \
  --agent frog \
  --owner "discord:YOUR_USER_ID" \
  --heartbeat-channel "discord-mybotname" \
  --heartbeat-interval-ms 7200000 \
  --heartbeat-idle-ms 7200000 \
  --heartbeat-prompt "You have been quiet for a while. Reflect on what you know and share something meaningful."
```

`--heartbeat-channel` is required when enabling heartbeat. It must be the OC channel account ID (e.g. `discord-mybotname`) — the same value shown in `openclaw.json` under `channels`.

| Flag | Default | Description |
|---|---|---|
| `--heartbeat-channel ID` | — | OC channel account ID to post to (required) |
| `--heartbeat-interval-ms MS` | 7200000 (2h) | Scheduled heartbeat interval |
| `--heartbeat-idle-ms MS` | 7200000 (2h) | Idle trigger threshold; set to `0` to disable idle heartbeats |
| `--heartbeat-prompt TEXT` | _(skill default)_ | Custom prompt sent to the character for heartbeat generation |
| `--heartbeat-target ID` | — | Target channel or user ID within the OC channel (platform-specific) |
| `--heartbeat-account ID` | — | OC account ID for multi-account deployments |
| `--disable-heartbeat` | — | Remove heartbeat config from this character |

### What heartbeat does

When a trigger fires, the OC plugin sends a `/generate` request with `is_heartbeat: true`. The ST plugin:

- Bypasses owner/guest trust labels — heartbeat is always autonomous
- Allows outbound actions in the response (the character can initiate posts, not just reply)
- Logs the generated response as a system entry in ST chat history
- Writes nothing to history if the response is empty (the character chose not to speak)

---

## Character memory

During generation, a character can call the `openclaw_write_memory` tool to persist a fact to a dedicated per-character lorebook. The file is created automatically on the first memory write:

```
data/default-user/worlds/{character}-auto-memory.json
```

### One-time setup: link the lorebook in ST

For lorebook entries to be injected into future generations, SillyTavern must know about the file:

1. Open the character's card in SillyTavern → **Creator** tab → **Books** section
2. Add `{character}-auto-memory` as an attached lorebook
3. Save the character

After this one-time step, memory entries the character writes will be available in all subsequent generations automatically.

### Memory tiers

| Tier | `tier` value | Behaviour | Use for |
|---|---|---|---|
| 1 | `1` (default) | Always injected (constant=true) | Core facts, always-relevant context |
| 2 | `2` | Keyword-triggered | Episode-specific memories, conditional context |

---

## After changing ST model or API settings

The headless browser caches its session at startup. If you change the LLM, API endpoint, or character settings in the ST UI, trigger a headless reload:

```bash
TOKEN=$(cat data/openclaw-bridge/bridge-token.txt)
curl -sS -X POST http://localhost:8000/api/plugins/openclaw-bridge/reload-headless \
  -H "Authorization: Bearer ${TOKEN}"
# Expected: {"reloaded":true}
```

---

## Removing a character

```bash
# Unlink from ST plugin
TOKEN=$(cat data/openclaw-bridge/bridge-token.txt)
curl -X DELETE http://localhost:8000/api/plugins/openclaw-bridge/characters/{STCharacterName}/link \
  -H "Authorization: Bearer ${TOKEN}"

# Remove OC agent
openclaw agents remove {agentname}
rm -rf ~/.openclaw/workspace-{agentname}
```
