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

This skill defines how the agent hands off every inbound message to SillyTavern for generation and acts on any outbound actions ST returns. Without it the agent has no knowledge of the bridge.

---

## Step 3 — Configure the agent

Add an entry to `~/.openclaw/openclaw.json` under `agents.list`. If you already have a `main` agent (most OC installs do), add the new entry directly below it:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "...": "your existing main agent config"
      },
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
    ]
  }
}
```

Replace `{agentname}`, `{Character Display Name}`, and `{token}` with real values. The token is in `data/openclaw-bridge/bridge-token.txt`.

`profile: "minimal"` gives the agent only `session_status` as its base tool set, structurally denying exec, cron, browser, gateway, and calendar tools at the config layer. `allow: ["read", "write"]` then grants workspace file access needed for character memory. See [OpenClaw security](oc-security.md) for a full explanation of why this matters.

---

## Step 4 — Link the character in SillyTavern

Open the character's card in SillyTavern's **Creator** tab. The bridge adds an **External Presence** section at the bottom of the form. Fill in:

- **OC Agent ID** — the agent ID from Step 1 (e.g. `frog`)
- **Owner User IDs** — one per line or comma-separated, in `platform:id` format (e.g. `discord:123456789012345678`). Owner messages receive `[OWNER]` trust; all others receive `[GUEST]`.

Enable the toggle, then click **Save link**. Use **Test connection** to confirm the plugin can reach OC before moving on.

---

### Via shell script (alternative)

`link-character.sh` covers the same fields and also lets you configure heartbeat and channels in one call — useful if you prefer the terminal, are scripting a multi-character setup, or want to hand the task to an agent:

```bash
./scripts/link-character.sh \
  --character "{STCharacterName}" \
  --agent "{agentname}" \
  --owner "{platform}:{ownerUserId}"
```

- `--character` must match the ST character name exactly (case-sensitive)
- `--agent` is the OC agent ID from Step 1
- `--owner` sets a trusted owner ID — repeat for multiple owners

Or call the API directly:

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

## Outbound messaging (send_message)

A character can send messages to a channel mid-generation using the `send_message` action — for example, posting an announcement, sending a DM to a user, or reacting to something autonomously during a heartbeat.

`send_message` routes by a logical channel name (e.g. `"dm"`, `"the-pond"`) that you configure in `character-links.json`. The bridge looks up the matching entry, validates it, and pre-resolves the OC adapter details before the action reaches OC.

Each channel is either a **DM** (a direct message to a user) or a **channel post** (a message into a channel). This is set per entry with a `kind` of `dm` or `channel`. The bridge turns `kind` + the recipient `id` into OpenClaw's generic target grammar — `user:<id>` for a DM, `channel:<id>` for a post — which works across Discord, Telegram, and other OpenClaw channels.

### Two ids, two roles

Don't confuse the two ids on a channel entry:

- **`channel_id`** — *which bot/platform to send through* (the OC channel/adapter id, e.g. `discord`). The same value whether you're DMing or posting.
- **recipient `id`** — *who/where on that platform*: your user id for a `dm`, the channel's id for a `channel`.

> **Finding Discord ids:** enable **Settings → Advanced → Developer Mode**, then right-click a user (for a DM) or a channel (for a post) → **Copy ID**.

### Configure channels

Use `link-character.sh` with the `--channel` flags to add channels without editing `character-links.json` directly. Run with `--help` to see every flag plus worked examples.

DM the owner — the character can send you a direct message:

```bash
./scripts/link-character.sh \
  --character "Frog" \
  --agent frog \
  --channel dm --channel-id discord --channel-kind dm --channel-recipient YOUR_DISCORD_USER_ID
```

Post to a channel ("The Pond"):

```bash
./scripts/link-character.sh \
  --character "Frog" \
  --agent frog \
  --channel the-pond --channel-id discord --channel-kind channel --channel-recipient THE_POND_CHANNEL_ID
```

Flags are repeatable — give the character both at once:

```bash
./scripts/link-character.sh \
  --character "Frog" \
  --agent frog \
  --channel dm       --channel-id discord --channel-kind dm      --channel-recipient YOUR_DISCORD_USER_ID \
  --channel the-pond --channel-id discord --channel-kind channel --channel-recipient THE_POND_CHANNEL_ID
```

Each call **merges** into the existing channel list by name — running the script twice with different `--channel` values won't clobber the first entry. To remove a channel by name:

```bash
./scripts/link-character.sh \
  --character "Frog" \
  --agent frog \
  --remove-channel the-pond
```

| Flag | Description |
|---|---|
| `--channel NAME` | Logical name the character uses in the `channel` parameter (e.g. `"dm"`, `"the-pond"`) |
| `--channel-id ID` | OC channel/adapter id — which bot/platform to send through (e.g. `"discord"`); required when `--channel` is used |
| `--channel-kind dm\|channel` | `dm` = direct-message the recipient; `channel` = post into the channel |
| `--channel-recipient ID` | Raw recipient id: your user id for `dm`, the channel id for `channel` |
| `--remove-channel NAME` | Remove the channel entry with this name |

The underlying `channels` schema stored in `character-links.json`:

| Field | Description |
|---|---|
| `name` | Logical label the character uses in the `channel` parameter (e.g. `"dm"`, `"the-pond"`) |
| `channel_id` | OC channel/adapter id — which bot/platform to send through (e.g. `"discord"`) |
| `kind` | `"dm"` or `"channel"` — direct message vs channel post |
| `id` | Raw recipient id: the user id for a `dm`, the channel id for a `channel` |

A character can have multiple entries — DM you *and* post to a channel, on one or several platforms.

### How the character uses it

The LLM can output a `send_message` action block in its response:

```
<action>{"type":"send_message","channel":"discord","content":"Hello from Frog!"}</action>
```

To send a direct message instead, include `recipient`:

```
<action>{"type":"send_message","channel":"discord","recipient":"USER_ID","content":"Just for you."}</action>
```

The `channel` value is the **logical `name`** you gave the channel above (e.g. `discord`) — **not** the platform's own display name for the destination (e.g. a Discord channel called `#general`). The character is told its configured channel names as part of the generation prompt, so it should use one of them directly.

If the character specifies a channel name that isn't in the `channels` list, the action is dropped (it is never sent) and:

- a one-off **warning toast** appears in SillyTavern naming the channel that failed and which names are configured, and
- the **External Presence** panel shows a red warning whenever the link is enabled but has no channels configured at all.

Both are there to make a missing or mistyped channel easy to spot. Add the channel (above) and the next attempt will resolve.

---

## Heartbeat / Autonomous presence

A character can post on a schedule or when a conversation goes quiet, without waiting for a user to send a message. Two triggers are available:

- **Scheduled**: fires every `interval_ms` milliseconds (default: 2 hours)
- **Idle**: fires once when no messages have arrived for `idle_threshold_ms` milliseconds (default: 2 hours), then resets after the next incoming message

Both triggers run inside the OC plugin's 60-second polling loop.

> **⚠️ Each heartbeat is a real LLM generation.** Every time a heartbeat fires it runs a full generation through your model — so it costs tokens/quota and (on paid models) money, on a recurring schedule with no user in the loop. A 5-minute interval means ~288 generations/day, per character. Pick an interval that matches how present you want the character to feel **and** what you're willing to spend; the default 2 hours is deliberately conservative. Start long, shorten only if you want more presence.

### `--heartbeat-channel` is the adapter id, not a per-bot name

`--heartbeat-channel` is passed straight to OpenClaw's outbound adapter, so it must be the **channel/adapter id** (e.g. `discord`) — the top-level key under `channels` in `openclaw.json` — **not** an account-suffixed name like `discord-mybotname`. Which bot account sends is a separate dimension: set it with `--heartbeat-account` (e.g. `frog`). A wrong channel id fails silently (logged as `no outbound adapter`), exactly like a mistyped `send_message` channel.

### Enable heartbeat

DM the owner on a schedule (a companion checking in):

```bash
./scripts/link-character.sh \
  --character "Frog" \
  --agent frog \
  --owner "discord:YOUR_USER_ID" \
  --heartbeat-channel discord \
  --heartbeat-kind dm \
  --heartbeat-target YOUR_DISCORD_USER_ID \
  --heartbeat-account frog \
  --heartbeat-interval-ms 7200000 \
  --heartbeat-idle-ms 0 \
  --heartbeat-prompt "You have been quiet for a while. Reflect on what you know and share something meaningful."
```

Or post into a channel instead — use `--heartbeat-kind channel` and a channel id for `--heartbeat-target`.

| Flag | Default | Description |
|---|---|---|
| `--heartbeat-channel ID` | — | OC channel/adapter id to send through (e.g. `discord`); required |
| `--heartbeat-kind dm\|channel` | channel | `dm` = the heartbeat DMs the recipient; `channel` = posts into the channel |
| `--heartbeat-target ID` | — | Raw recipient: your user id when `kind=dm`, the channel id when `kind=channel` |
| `--heartbeat-account ID` | — | Which bot account sends (e.g. `frog`); required when the channel has no single default account |
| `--heartbeat-interval-ms MS` | 7200000 (2h) | Scheduled heartbeat interval (see the cost note above) |
| `--heartbeat-idle-ms MS` | 7200000 (2h) | Idle trigger threshold; set to `0` to disable idle heartbeats |
| `--heartbeat-prompt TEXT` | _(skill default)_ | Custom prompt sent to the character for heartbeat generation |
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

---

## Maintenance

### After changing ST model or API settings

The headless browser caches its session at startup. If you change the LLM, API endpoint, or character settings in the ST UI, reload it from the repository root:

```bash
./scripts/reload-headless.sh
# Expected: {"reloaded":true}
```

The script reads the bridge token automatically — no need to look it up or `cd` first.

### Removing a character

To disable the link temporarily, toggle the **External Presence** panel off in ST's character editor and click **Save link**. The character stops responding on external channels but all config is preserved.

To remove it entirely:

```bash
# Unlink from ST plugin
./scripts/link-character.sh --character "{STCharacterName}" --unlink

# Remove OC agent and workspace
openclaw agents remove {agentname}
rm -rf ~/.openclaw/workspace-{agentname}
```
