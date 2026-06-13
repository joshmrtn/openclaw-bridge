# openclaw-bridge

Bridging the gap between SillyTavern and OpenClaw so AI companion characters
maintain a single canonical identity across all communication channels.
SillyTavern is the brain (character cards, lorebooks, LLM pipeline).
OpenClaw is the body (Discord, Telegram, autonomous actions).

## Prerequisites

Before starting, ensure:

- **SillyTavern** is installed and running (default: `http://localhost:8000`)
- **OpenClaw gateway** is installed and running (`openclaw health` returns ok)
- **Node.js 22+** is available (`node -v`)

---

## One-time setup

### 1. Clone and run setup

```bash
git clone https://github.com/joshmrtn/openclaw-bridge.git
cd openclaw-bridge
./setup.sh
```

`setup.sh` does the following automatically:

- Checks Node.js 22+ and the OpenClaw CLI
- Installs plugin dependencies
- Finds your SillyTavern installation and copies the plugin and extension into it
  (it checks common locations and prompts you to confirm or enter a path if needed)
- Generates a bridge auth token at `data/openclaw-bridge/bridge-token.txt`
- Symlinks the token and character-links file into `~/.openclaw/openclaw-bridge/`
  so the OC gateway plugin can find them without extra configuration
- Installs the OC gateway plugin if the `openclaw` CLI is in your PATH

After setup, **restart SillyTavern** and **refresh your browser tab**. Verify the plugin loaded:

```bash
curl http://localhost:8000/api/plugins/openclaw-bridge/status
# Expected: {"status":"ok",...}
```

If `setup.sh` could not find or install into SillyTavern automatically, install manually:

```bash
cp -r st-plugin /path/to/SillyTavern/plugins/openclaw-bridge
cp -r st-extension /path/to/SillyTavern/public/scripts/extensions/openclaw-bridge
```

### 2. Install the OC gateway plugin

`./setup.sh` installs this automatically when `openclaw` is in your PATH.
To install or reinstall manually:

```bash
openclaw plugins install --path ./oc-plugin
openclaw gateway restart
```

Verify it loaded:

```bash
openclaw plugins list
# Expected: openclaw-bridge appears in the list
```

The plugin reads data from `~/.openclaw/openclaw-bridge/` by default.
`setup.sh` symlinks `data/openclaw-bridge/` there so the token and character
links are shared without any extra configuration.

### 3. Headless mode

The plugin launches a headless Playwright browser automatically when ST starts,
so generation always works even without an open browser tab. No extra
configuration needed — Playwright is installed as a dev dependency.

If the headless service loses its connection (e.g. after an ST restart), it
reconnects automatically. You can also trigger a manual reload to pick up
model or API changes made in the ST UI:

```bash
TOKEN=$(cat data/openclaw-bridge/bridge-token.txt)
curl -X POST http://localhost:8000/api/plugins/openclaw-bridge/reload-headless \
  -H "Authorization: Bearer ${TOKEN}"
# Expected: {"reloaded":true}
```

---

## Per-character setup

Repeat the steps below for every SillyTavern character you want to expose
via OpenClaw.

### 1. Link the character

```bash
./scripts/link-character.sh \
  --character "Gerard Fontaine" \
  --agent gerard \
  --owner "discord:YOUR_DISCORD_USER_ID"
```

- `--character` must match the character name exactly as it appears in ST
- `--agent` is the OC agent ID you will create next
- `--owner` is a user ID in `platform:id` format that receives `[OWNER]` trust
  (repeat for multiple owners); all others receive `[GUEST]`

### 2. Create the OC agent

Follow `AGENT-SETUP.md` for the complete OC-side steps: creating the agent,
installing the `character-bridge` skill, configuring the agent environment, and
binding it to a channel. `AGENT-SETUP.md` also covers optional features:
heartbeat / autonomous presence and per-character memory.

---

## Verification

After setup, run the verification script to confirm the pipeline is healthy:

```bash
./scripts/verify.sh
# or, to also check a character link:
./scripts/verify.sh --character "Gerard Fontaine"
# or, to additionally send a test generation:
./scripts/verify.sh --character "Gerard Fontaine" --test
```

---

## Configuration

| Variable | Purpose |
|---|---|
| `OPENCLAW_BRIDGE_URL` | Base URL where the plugin is reachable (used by OC agents) |
| `OPENCLAW_BRIDGE_TOKEN` | Bearer token OC agents use when calling the plugin |
| `OPENCLAW_BRIDGE_AUTH_TOKEN` | Alias for `OPENCLAW_BRIDGE_TOKEN` on the plugin side |
| `OPENCLAW_BRIDGE_TOKEN_PATH` | Optional path to a token file (used if env vars are unset) |
| `OPENCLAW_BRIDGE_WS_PORT` | WebSocket server port (default: 8765) |
| `OPENCLAW_BRIDGE_ALLOW_FALLBACK` | `true` enables mock generator fallback — dev only, never production |
| `OPENCLAW_BRIDGE_ENABLE_HEADLESS` | Set to `false` to disable the headless Playwright service |
| `OPENCLAW_BRIDGE_ST_URL` | URL the headless service navigates to (default: `http://127.0.0.1:8000`) |

If no token env var is set, the plugin auto-loads from common paths including
`data/openclaw-bridge/bridge-token.txt` generated by `./setup.sh`.

---

## Troubleshooting

### CSRF errors when calling plugin endpoints

The bridge handles CSRF automatically by fetching ST's token before each
plugin request. If you see 403 errors when calling plugin endpoints directly
with `curl`, add `-H "x-csrf-token: $(curl -s http://localhost:8000/csrf-token | grep -o '[a-f0-9-]*')"`,
or use Bearer token auth instead (the bridge uses Bearer auth, not CSRF).

### Character not found / generation returns 400

The `character` field in `/generate` must match the ST character name exactly,
including capitalisation and spaces. Check the character's filename in ST's
`data/default-user/characters/` — the name without the `.png` extension is
what the API expects. Use `/api/plugins/openclaw-bridge/characters` to list
all known characters.

### No WS clients / headless service not ready

After ST starts, the headless Playwright browser needs ~15–30 seconds to load
and connect. Check progress:

```bash
TOKEN=$(cat data/openclaw-bridge/bridge-token.txt)
curl http://localhost:8000/api/plugins/openclaw-bridge/health \
  -H "Authorization: Bearer ${TOKEN}"
```

Look for `"isConnected":true` in the `headless` block. If Playwright is not
installed, run:

```bash
cd st-plugin && npx playwright install chromium
```

If the headless service fails repeatedly, set `OPENCLAW_BRIDGE_ENABLE_HEADLESS=false`
and use the browser extension manually instead (open ST in a browser tab with
the extension installed).

### Bridge token confusion

The plugin reads the token from `data/openclaw-bridge/bridge-token.txt` (or
env vars `OPENCLAW_BRIDGE_AUTH_TOKEN` / `OPENCLAW_BRIDGE_TOKEN`). OC agents
read from `~/.openclaw/openclaw-bridge/bridge-token.txt`. `setup.sh` symlinks
these so they point to the same file. If tokens get out of sync, regenerate:

```bash
openssl rand -hex 32 > data/openclaw-bridge/bridge-token.txt
# then update OPENCLAW_BRIDGE_TOKEN in openclaw.json for each agent
```

### ST on a remote server (SSH / WS port)

If ST runs on a remote server and OC runs locally, the WebSocket port (default
8765) must be reachable from the OC gateway. Either:

- Open port 8765 in your firewall, or
- Tunnel it over SSH:
  ```bash
  ssh -L 8765:localhost:8765 user@yourserver
  ```
  Then set `OPENCLAW_BRIDGE_WS_PORT=8765` in the OC plugin environment and
  point `OPENCLAW_BRIDGE_URL` at the forwarded ST URL.

### OC plugin changes not taking effect

The OC gateway plugin is TypeScript compiled to `oc-plugin/dist/index.js`.
After editing `oc-plugin/src/index.ts`, rebuild and restart:

```bash
cd oc-plugin && npx tsc
openclaw gateway restart
```

If changes still seem absent, check that `~/.openclaw/extensions/openclaw-bridge/`
is a symlink to `oc-plugin/` (created by `dev-setup.sh`) rather than a stale
installed copy.

### Headless service not reconnecting after ST restart

The headless service automatically attempts to reconnect for up to ~3 minutes
after the page is lost. Watch the ST server log for
`[openclaw-bridge-headless] Reconnect attempt N/20...`.

If it exhausts all attempts, trigger a manual restart by sending a request to
`/reload-headless` (which errors cleanly if the page is fully gone), or restart
ST — the plugin will re-launch the headless browser on the next init.

---

## Development workflow

If SillyTavern is checked out in this repo at `./sillytavern`, run:

```bash
bash ./dev-setup.sh
```

This symlinks `./st-plugin` and `./st-extension` into ST so you can edit and
test immediately by restarting ST.

Run the test suite:

```bash
# All unit tests
npm test

# Plugin tests only (faster — no Playwright startup)
OPENCLAW_BRIDGE_ENABLE_HEADLESS=false npm test -- st-plugin --forceExit
```

Mock tools for manual testing (no real OC or browser needed):

- `st-plugin/tools/fake-extension.js` — connects to the WS and echoes a fixed response
- `st-plugin/tools/mock-openclaw.js` — simulates the full OC → ST pipeline

---

## Repository layout

```
openclaw-bridge/
├── README.md
├── AGENT-SETUP.md          # per-character OC agent setup guide
├── setup.sh                # one-time bootstrap — run this first
├── start.sh                # starts SillyTavern with preflight checks
├── dev-setup.sh            # symlinks plugin/extension into a local ST checkout
├── scripts/
│   ├── link-character.sh   # links a ST character to an OC agent
│   └── verify.sh           # end-to-end pipeline verification
├── oc-plugin/              # OC gateway plugin (TypeScript)
│   ├── src/index.ts        # source — edit here
│   ├── dist/index.js       # compiled output — rebuild: cd oc-plugin && npx tsc
│   └── openclaw.plugin.json
├── skills/character-bridge/  # per-agent skill (fallback LLM routing)
│   ├── SKILL.md
│   └── README.md
├── st-plugin/              # SillyTavern Node.js server plugin
└── st-extension/           # SillyTavern browser extension
```
