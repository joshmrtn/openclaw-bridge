# Troubleshooting

---

## Plugin didn't load / status endpoint returns 404

SillyTavern does not load server plugins by default.

1. Open `SillyTavern/config.yaml`
2. Set `enableServerPlugins: true`
3. Restart SillyTavern

If the status endpoint still fails after restarting, check the ST server log for any error from `openclaw-bridge` on startup.

---

## 401 Unauthorized on plugin endpoints

The bridge token in your request does not match what the plugin expects.

- The plugin reads its token from `data/openclaw-bridge/bridge-token.txt` (or the `OPENCLAW_BRIDGE_AUTH_TOKEN` / `OPENCLAW_BRIDGE_TOKEN` environment variables)
- OC agents read from `~/.openclaw/openclaw-bridge/bridge-token.txt`
- `setup.sh` symlinks these so they point to the same file — if tokens get out of sync, regenerate:

```bash
openssl rand -hex 32 > data/openclaw-bridge/bridge-token.txt
# then update OPENCLAW_BRIDGE_TOKEN in openclaw.json for each agent and restart OC
```

---

## 403 CSRF errors when calling plugin endpoints with curl

The bridge uses Bearer token auth, not CSRF. When calling endpoints directly with curl, include the Authorization header:

```bash
curl -H "Authorization: Bearer $(cat data/openclaw-bridge/bridge-token.txt)" \
  http://localhost:8000/api/plugins/openclaw-bridge/status
```

If you see 403s in the ST server log during normal operation (not curl), set `disableCsrf: true` in `SillyTavern/config.yaml` for local development.

---

## Character not found / generation returns 400

The `character` field in `/generate` must match the ST character name exactly, including capitalisation and spaces. Check the character's filename in ST's `data/default-user/characters/` — the name without the `.png` extension is what the API expects.

List all known characters:

```bash
TOKEN=$(cat data/openclaw-bridge/bridge-token.txt)
curl http://localhost:8000/api/plugins/openclaw-bridge/characters \
  -H "Authorization: Bearer ${TOKEN}"
```

---

## No WS clients / headless service not ready

After ST starts, the headless Playwright browser needs ~15–30 seconds to load and connect. Check progress:

```bash
TOKEN=$(cat data/openclaw-bridge/bridge-token.txt)
curl http://localhost:8000/api/plugins/openclaw-bridge/health \
  -H "Authorization: Bearer ${TOKEN}"
```

Look for `"isConnected": true` in the `headless` block.

If Playwright is not installed:

```bash
cd st-plugin && npx playwright install chromium
```

If the headless service fails repeatedly, you can disable it and use your browser tab as the generation client instead:

```bash
OPENCLAW_BRIDGE_ENABLE_HEADLESS=false node server.js   # start ST with headless disabled
```

With headless disabled, keep a SillyTavern browser tab open whenever generation is needed.

---

## Headless service not reconnecting after ST restart

The headless service automatically attempts to reconnect for up to ~3 minutes (20 attempts, 10s apart) after the page is lost. Watch the ST server log for:

```
[openclaw-bridge-headless] Reconnect attempt N/20...
```

If it exhausts all attempts, trigger a manual reload:

```bash
TOKEN=$(cat data/openclaw-bridge/bridge-token.txt)
curl -X POST http://localhost:8000/api/plugins/openclaw-bridge/reload-headless \
  -H "Authorization: Bearer ${TOKEN}"
```

Or restart SillyTavern — the plugin re-launches the headless browser on the next init.

---

## OC plugin changes not taking effect

The OC gateway plugin is TypeScript compiled to `oc-plugin/dist/index.js`. After editing `oc-plugin/src/index.ts`, rebuild and restart:

```bash
cd oc-plugin && npx tsc
openclaw gateway restart
```

If changes still seem absent, check that `~/.openclaw/extensions/openclaw-bridge/` is a symlink to `oc-plugin/` (created by `dev-setup.sh`) rather than a stale installed copy:

```bash
ls -la ~/.openclaw/extensions/openclaw-bridge
```

---

## Messages appearing duplicated in ST chat history

A double-write was introduced somewhere. History is written explicitly by the ST plugin after generation — it must not also be written inside the browser extension's `generateForCharacter()` function. Check both locations if you see duplicates:

- `st-plugin/index.js` — the `/generate` handler calls `appendExternalChatToHistory()` after receiving the response
- `st-extension/index.js` — `generateForCharacter()` must not write to history

---

## ST on a remote server (WebSocket port not reachable)

If ST runs on a remote server and OC runs locally, port 8765 (the WebSocket port) must be reachable from the OC gateway. Either open port 8765 in your firewall, or tunnel it over SSH:

```bash
ssh -L 8765:127.0.0.1:8765 user@yourserver -N
```

Then set `OPENCLAW_BRIDGE_WS_PORT=8765` in the OC plugin environment and point `OPENCLAW_BRIDGE_URL` at the forwarded ST URL.

> Note: in VS Code SSH setups, port 8765 is not reliably forwarded through VS Code's port forwarding UI. Use the explicit SSH tunnel above instead.

---

## Generation times out for no apparent reason

The default generation timeout is 900 seconds (15 minutes). Local Ollama models can legitimately take 5–10 minutes on modest hardware — a timeout does not necessarily mean something is broken.

If you are seeing consistent timeouts on a fast model or API, check:

1. The headless browser is connected (`/health` endpoint)
2. The correct character is linked (`/characters` endpoint)
3. The LLM API key / endpoint is configured correctly in ST's UI settings
4. The headless browser has picked up the current ST settings — trigger a reload if you recently changed them:

```bash
TOKEN=$(cat data/openclaw-bridge/bridge-token.txt)
curl -X POST http://localhost:8000/api/plugins/openclaw-bridge/reload-headless \
  -H "Authorization: Bearer ${TOKEN}"
```
