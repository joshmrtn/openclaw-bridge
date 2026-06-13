# Getting started

This guide walks through installing openclaw-bridge for the first time. By the end you will have the plugin and extension running inside SillyTavern and the OC gateway plugin loaded, ready to link your first character.

If you want to understand what each component is before installing, read [Architecture](architecture.md) first.

---

## Prerequisites

Before starting, ensure:

- **SillyTavern** is installed and you can open it in a browser (default: `http://localhost:8000`)
- **OpenClaw gateway** is installed and running — `openclaw health` returns ok
- **Node.js 22+** is available — `node -v` to check

---

## Step 1 — Clone the repository

```bash
git clone https://github.com/joshmrtn/openclaw-bridge.git
cd openclaw-bridge
```

---

## Step 2 — Run setup

```bash
./setup.sh
```

`setup.sh` will:

1. Check your Node.js and OpenClaw versions
2. Install the plugin's npm dependencies
3. Find your SillyTavern installation (checks common locations) and copy the plugin and extension into it — it will ask you to confirm the path, or prompt you to enter one if it cannot find ST automatically
4. Generate a bridge auth token at `data/openclaw-bridge/bridge-token.txt`
5. Symlink the token and character-links file into `~/.openclaw/openclaw-bridge/` so the OC gateway plugin can find them
6. Install the OC gateway plugin if the `openclaw` CLI is in your PATH

**Non-interactive / scripted install:** if you know where SillyTavern is, skip the prompts:

```bash
./setup.sh --st-path ~/SillyTavern
```

---

## Step 3 — Enable server plugins in SillyTavern

The bridge plugin is a server-side ST plugin. ST does not load these by default.

1. Open `SillyTavern/config.yaml` in a text editor
2. Find `enableServerPlugins` and set it to `true`
3. Save the file

---

## Step 4 — Restart SillyTavern

Stop SillyTavern and start it again. On startup it will load the plugin and launch the headless Playwright browser (the background browser that handles generation).

Verify the plugin loaded:

```bash
curl http://localhost:8000/api/plugins/openclaw-bridge/status
```

Expected response:

```json
{"status":"ok","version":"...","connected_ws_clients":0}
```

---

## Step 5 — Refresh your browser tab

Open or refresh SillyTavern in your browser. The extension loads automatically and connects to the plugin over WebSocket. After a few seconds you should see the client count rise in the status endpoint:

```bash
curl http://localhost:8000/api/plugins/openclaw-bridge/status
# connected_ws_clients should be 1 or more
```

> **Tip:** The headless browser (a background Playwright instance) also counts as a connected client. If you see `connected_ws_clients: 1` before opening your browser tab, that is the headless service — which is exactly what you want.

---

## Step 6 — Verify the OC gateway plugin

```bash
openclaw plugins list
# Expected: openclaw-bridge appears in the list

openclaw gateway restart
# Applies the plugin installation
```

---

## Step 7 — Run the verification script

```bash
./scripts/verify.sh
```

This checks the full stack: plugin reachability, token auth, WebSocket clients, and headless service status. Fix any warnings before continuing.

To also verify a specific character link (once you have one):

```bash
./scripts/verify.sh --character "My Character"
```

---

## What's next

Add your first character: [Adding a character](adding-a-character.md)

If anything went wrong during setup: [Troubleshooting](troubleshooting.md)
