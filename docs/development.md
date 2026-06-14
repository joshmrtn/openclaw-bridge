# Development

---

## Prerequisites

- Node.js 22+
- The `sillytavern` git submodule checked out (`git submodule update --init`)
- Optionally: the `openclaw` CLI in your PATH, and a local Ollama instance for full E2E testing

---

## Setup

Wire everything into your local ST submodule checkout and symlink the OC plugin:

```bash
bash ./dev-setup.sh
```

This does two things:
1. Replaces `SillyTavern/plugins/openclaw-bridge/` and `SillyTavern/public/scripts/extensions/openclaw-bridge/` with symlinks to `st-plugin/` and `st-extension/` respectively — changes to source files take effect immediately without re-copying.
2. Replaces `~/.openclaw/extensions/openclaw-bridge/` with a symlink to `oc-plugin/` — same benefit for the OC plugin.

After `dev-setup.sh`, start ST from the submodule:

```bash
cd sillytavern && node server.js
```

---

## Tests

```bash
# All unit tests
npm test

# Faster: suppress Playwright startup noise
OPENCLAW_BRIDGE_ENABLE_HEADLESS=false npm test -- --forceExit

# Single file
npm test -- --testPathPattern=session-manager

# Plugin tests only
npm test -- st-plugin

# Docker E2E — fast tier (ST + fake-extension + fake-ollama, no OC repo needed)
npm run test:e2e:fast

# Docker E2E — full tier (real OC gateway + qa-bus + headless Playwright)
npm run test:e2e:full
```

Unit tests mock the WebSocket, session manager, and filesystem — no ST process required. Jest auto-discovers `*.test.js` files under `st-plugin/tests/`. Files under `st-plugin/tools/` are manual helpers and not picked up by Jest.

The Docker E2E tiers run the full message path in isolated containers — the only mocks are the LLM and the fake channel. See **[Docker E2E testing](docker-e2e.md)** for setup, architecture, and when to run each tier.

---

## Manual end-to-end testing

### Fake extension

Connects to the WebSocket and echoes a fixed response. Use it to test the plugin round-trip (history writes, trust labels, concurrency) without a real browser or LLM:

```bash
node st-plugin/tools/fake-extension.js
```

### Mock OpenClaw client

Simulates the full OC → ST pipeline without real OC infrastructure:

```bash
# Interactive: choose a scenario
node st-plugin/tools/mock-openclaw.js --test-scenario

# Send a single message
node st-plugin/tools/mock-openclaw.js \
  --character "Frog" \
  --message "Hello!" \
  --user-id "discord:123456"
```

Token is auto-loaded from `data/openclaw-bridge/bridge-token.txt`.

### Verify the full stack

```bash
./scripts/verify.sh
./scripts/verify.sh --character "My Character"
```

---

## OC plugin development

The OC plugin is TypeScript. The source is `oc-plugin/src/index.ts`; OC loads the compiled output from `~/.openclaw/extensions/openclaw-bridge/dist/index.js` (symlinked to `oc-plugin/dist/` by `dev-setup.sh`).

After editing the source, recompile:

```bash
/path/to/openclaw/node_modules/typescript/bin/tsc --project oc-plugin/tsconfig.json
```

Then restart OC:

```bash
openclaw gateway restart
```

If a change appears to have no effect, check that the symlink is intact:

```bash
ls -la ~/.openclaw/extensions/openclaw-bridge
```

If it's a real directory rather than a symlink, re-run `dev-setup.sh`.

---

## Adding a new character action tool

Character action tools let the ST brain instruct the OC body to take outbound actions during generation. Adding one requires changes in two files:

### 1. Register in `st-extension/index.js`

Inside `registerBridgeTools()`, add a `context.registerFunctionTool(...)` call:

```js
context.registerFunctionTool({
    name: 'openclaw_<action_name>',
    displayName: 'Human-readable name',
    description: 'What this tool does and when to use it.',
    parameters: {
        type: 'object',
        properties: {
            my_param: { type: 'string', description: 'What this param is' },
        },
        required: ['my_param'],
    },
    stealth: true,
    action: async (params) => {
        queueCharacterAction('<action_name>', params);
        return { queued: true };
    },
});
```

### 2. Implement in `oc-plugin/src/index.ts`

Add a `case` in the `switch` inside `executeCharacterActions`:

```ts
case "<action_name>": {
    const adapter = await api.runtime.channel.outbound.loadAdapter(ctx.channelId);
    if (!adapter?.sendText) { outcome = "no outbound adapter"; break; }
    await adapter.sendText({
        cfg: api.config,
        to: String(action.my_param ?? ""),
        text: String(action.content ?? ""),
        ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
    });
    outcome = "sent";
    break;
}
```

No changes to the `/generate` handler or trust enforcement are needed — `pendingActions` is already forwarded to OC and stripped for guests automatically.

---

## Repository structure

```
st-plugin/              Node.js CommonJS server plugin loaded by SillyTavern
st-plugin/tests/        Jest unit tests (auto-discovered)
st-plugin/tools/        Manual test helpers — not picked up by Jest
st-extension/           Browser JS extension loaded by SillyTavern
oc-plugin/              OpenClaw plugin (TypeScript); compiled to dist/
skills/character-bridge/ OC skill definitions — YAML + Markdown
sillytavern/            Git submodule — ST vendor checkout for dev/testing only
data/                   Runtime data (bridge token, character-links.json)
docs/                   User-facing documentation
scripts/                Shell helpers (link-character.sh, verify.sh)
```

### Key files

| File | Purpose |
|---|---|
| `st-plugin/index.js` | Route registration, `init()` entry point, auth middleware |
| `st-plugin/session-manager.js` | In-memory client registry and pending-request map |
| `st-plugin/ws-server.js` | WebSocket server |
| `st-plugin/generator.js` | WS dispatch, request/response correlation |
| `st-plugin/link-state.js` | Persisted character → OC agent link config |
| `st-plugin/chat-history.js` | JSONL read/write for ST chat files |
| `st-plugin/headless-service.js` | Playwright headless browser service |
| `st-extension/index.js` | Extension bootstrap, `generateForCharacter()` |
| `skills/character-bridge/SKILL.md` | OC tool schemas and agent instructions |

---

## Architecture decisions

### Generation lives in the browser, not the plugin

`Generate('quiet', { force_chid })` is only accessible from ST's browser context via `SillyTavern.getContext()`. The plugin cannot call it server-side. The WebSocket round-trip is intentional and required — do not attempt to move generation into the plugin or call ST's LLM endpoints directly, as both approaches bypass ST's full prompt assembly pipeline.

### `Generate('quiet')` does not write history

Quiet generation returns text without saving to chat history or rendering in the ST UI. History writes are a separate explicit step in the `/generate` handler after the extension returns. Do not add history writes inside the extension's `generateForCharacter()`. If messages appear duplicated in ST, a double-write was introduced — check both locations.

### Headless service is always preferred

`session-manager.js:getClient()` always prefers clients registered with `isHeadless: true`. The user's browser tab is a fallback, never the primary generation client.

### Trust labels are code-enforced

Every `/generate` request includes a `user_id`. The plugin compares it against `owner_user_ids` from link-state and prepends `[OWNER]` or `[GUEST]` before generation. This is hard enforcement — a guest message cannot escalate to owner trust regardless of content.

### Route registration order matters

`init()` registers routes in a fixed order that test mocks depend on. Add new routes at the end, with `log-action` registered before `generate`.

---

## LLM strategy for tests

Unit tests mock all LLM responses. For integration tests, use Ollama locally (`ollama pull qwen2.5:3b`) or Gemini Flash (free tier). The WebSocket generation timeout is 900000ms (15 minutes) — do not reduce it; local Ollama models can take 5–10 minutes on modest hardware.
