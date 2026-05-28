# OpenClaw Setup Instructions for character-bridge

These instructions are for an AI agent helping set up the
openclaw-bridge system. Follow each step exactly.

## Prerequisites (verify before starting)

1. SillyTavern is installed and running at http://localhost:8000
2. The openclaw-bridge ST plugin is installed and loaded
   - Verify: GET http://localhost:8000/api/plugins/openclaw-bridge/status
   - Expected response contains: { "status": "ok" }
3. You have the bridge auth token (OPENCLAW_BRIDGE_TOKEN)
4. You have the character's exact name as it appears in SillyTavern
5. OpenClaw gateway is running (openclaw health should return ok)

## Steps to add a new character agent

### Step 1: Create the agent

```bash
openclaw agents add {agentname} --workspace ~/.openclaw/workspace-{agentname}
```

Replace {agentname} with the character's name in lowercase with no spaces.
Example: for "Gerard Fontaine" use "gerard-fontaine"

### Step 2: Install the character-bridge skill

```bash
cp -r /path/to/openclaw-bridge/skills/character-bridge \
  ~/.openclaw/workspace-{agentname}/skills/
```

### Step 3: Configure the agent

Add to ~/.openclaw/openclaw.json under agents.list:

```json
{
  "id": "{agentname}",
  "name": "{Character Display Name}",
  "workspace": "~/.openclaw/workspace-{agentname}",
  "skills": ["character-bridge"],
  "env": {
    "OPENCLAW_BRIDGE_URL": "http://localhost:8000",
    "OPENCLAW_BRIDGE_TOKEN": "{token}"
  },
  "tools": {
    "allow": ["message", "read", "write"],
    "deny": [
      "exec", "process", "sandbox_exec", "sandbox_process",
      "browser", "gateway", "cron", "email", "calendar",
      "edit", "apply_patch"
    ]
  },
  "sandbox": {
    "mode": "all",
    "scope": "agent",
    "docker": { "network": "bridge" }
  }
}
```

### Step 4: Register the character link in ST

```bash
curl -X POST http://localhost:8000/api/plugins/openclaw-bridge/characters/{STCharacterName}/link \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "oc_agent_id": "{agentname}",
    "owner_user_ids": ["{platform}:{ownerUserId}"]
  }'
```

The owner_user_ids array accepts IDs in the format "platform:id",
for example "discord:123456789012345678" or "telegram:987654321".
These users get [OWNER] label. All others get [GUEST] label.

### Step 5: Bind the agent to a channel

Follow OC's channel documentation for your chosen platform
(Discord, Telegram, etc.) to bind the agent to the correct
channel or bot account.

### Step 6: Verify

```bash
# Restart OC gateway to pick up config changes
openclaw gateway restart

# Verify skill loaded
openclaw skills list --agent {agentname}
# Expected: character-bridge appears in the list

# Send a test message
openclaw agent --agent {agentname} \
  --message "Hello, this is a test"
# Expected: response is generated in character via SillyTavern
```

## Removing a character

```bash
# Unlink from ST plugin
curl -X DELETE http://localhost:8000/api/plugins/openclaw-bridge/characters/{STCharacterName}/link \
  -H "Authorization: Bearer {token}"

# Remove OC agent
openclaw agents remove {agentname}

# Remove workspace
rm -rf ~/.openclaw/workspace-{agentname}
```
