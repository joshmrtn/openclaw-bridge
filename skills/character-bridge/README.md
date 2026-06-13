# character-bridge skill

This skill connects an OpenClaw character agent to SillyTavern so that
all responses are generated using the full ST character pipeline —
character card, lorebook, memory, and LLM settings — rather than the
agent's base model.

## What it does

- Defines two tools: `generate_response` and `log_action`
- Teaches the agent to route all responses through SillyTavern
- Enforces a trust tier system (owner vs guest)

## Installation

Install this skill into a character agent's workspace:

```bash
cp -r skills/character-bridge ~/.openclaw/workspace-{agentname}/skills/
```

Then set the required environment variables in the agent's OC config:

```json
{
  "id": "frog",
  "skills": ["character-bridge"],
  "tools": {
    "profile": "minimal",
    "allow": ["read", "write"]
  },
  "env": {
    "OPENCLAW_BRIDGE_URL": "http://localhost:8000",
    "OPENCLAW_BRIDGE_TOKEN": "your-token-here"
  }
}
```

`profile: "minimal"` structurally denies all dangerous built-in tools (exec,
process, cron, gateway, browser, email, calendar, etc.) at the OC config layer.
`read` and `write` are the only built-in tools this agent needs (workspace file
access for character memory). The skill's own HTTP tools (`generate_response`,
`log_action`) are unaffected by the profile.

Restart the OC gateway after installing.

## Trust tiers

Configure the owner's user ID in the ST plugin's character link config.
The plugin injects [OWNER] or [GUEST] labels automatically.
