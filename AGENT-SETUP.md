# Adding a character agent in OpenClaw

This guide walks through creating an OpenClaw agent for a SillyTavern character
so it can respond via Discord, Telegram, or other OC channels.

Complete `README.md` steps 1–5 (one-time setup) before following this guide.

---

## Prerequisites

- SillyTavern is running and the openclaw-bridge plugin is loaded:
  ```bash
  curl http://localhost:8000/api/plugins/openclaw-bridge/status
  # Expected: {"status":"ok",...}
  ```
- You have the bridge auth token (printed by `setup.sh`, stored in `data/openclaw-bridge/bridge-token.txt`)
- The character exists in SillyTavern and you know its exact name
- The OpenClaw gateway is running (`openclaw health` returns ok)

---

## Step 1 — Create the agent

```bash
openclaw agents add {agentname} --workspace ~/.openclaw/workspace-{agentname}
```

Use the character's name in lowercase with hyphens: `gerard-fontaine` for "Gerard Fontaine".

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

Replace `{agentname}`, `{Character Display Name}`, and `{token}` with real values.
The token is in `data/openclaw-bridge/bridge-token.txt`.

**Why `profile: "minimal"` + `allow: ["read", "write"]`:**
`profile: "minimal"` gives the agent only `session_status` as its base set of
built-in tools, which structurally denies exec, cron, gateway, browser, email,
and calendar tools at the config layer. `allow: ["read", "write"]` then grants
workspace file access needed for character memory (R11). The bridge's
`generate_response` and `log_action` tools are HTTP-defined skills — they are
not affected by the profile.

---

## Step 4 — Link the character in ST

```bash
./scripts/link-character.sh \
  --character "{STCharacterName}" \
  --agent "{agentname}" \
  --owner "{platform}:{ownerUserId}"
```

- `--character` must match the ST character name exactly (case-sensitive)
- `--agent` is the OC agent ID from step 1
- `--owner` sets a trusted owner ID in `platform:id` format, e.g. `discord:123456789012345678`
  (repeat for multiple owners); owner messages receive `[OWNER]` trust, all others `[GUEST]`

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

Follow OC's channel documentation for your platform (Discord, Telegram, etc.)
to connect the agent to a bot account or channel.

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

## Character memory (R11)

During generation, a character can call the `openclaw_write_memory` tool to persist facts
to a dedicated per-character lorebook. Entries are written to:

```
data/default-user/worlds/{character}-auto-memory.json
```

For those entries to be injected into future generations, SillyTavern must know about the
lorebook. Link it once in the ST UI:

1. Open the character's card in SillyTavern → **Creator** tab → **Books** section.
2. Add `{character}-auto-memory` as an attached lorebook.
   (The file is created automatically on the character's first `openclaw_write_memory` call.)
3. Save the character.

After linking, all memory entries the character writes will be available in subsequent
generations without further setup.

---

## After changing ST model or API settings

The headless browser caches its session at startup. If you change the LLM,
API endpoint, or character settings in the ST UI, trigger a headless reload:

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
