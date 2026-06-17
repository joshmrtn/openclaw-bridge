# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

This project bridges OpenClaw (OC) and SillyTavern (ST) so that AI companion characters maintain a single canonical identity across all communication channels. ST is the brain (character cards, lorebooks, memory, LLM pipeline). OC is the body (Discord, Telegram, WhatsApp, autonomous scheduled actions). OC character agents install the `character-bridge` skill, which teaches them to POST incoming messages to the ST plugin rather than responding directly.

## Commands

```bash
# Install dependencies
npm install

# Run all unit tests
npm test

# Run a single test file
npm test -- --testPathPattern=session-manager

# Run unit tests for plugin only
npm test -- st-plugin

# Run unit tests without Playwright startup noise (much faster)
OPENCLAW_BRIDGE_ENABLE_HEADLESS=false npm test -- --forceExit

# Run E2E tests (Playwright — requires ST running)
npm run test:e2e

# Wire plugin and extension into local ST checkout, and symlink OC plugin into OpenClaw
bash ./dev-setup.sh

# Generate bridge token and set up data directory
./setup.sh
```

## Repository Structure

```
shared/                 Shared modules consumed by both plugin and extension
shared/tool-defs.js     Single source of truth for ACTION_TOOL_DEFS and ST_SIDE_TOOL_DEFS
st-plugin/              Node.js CommonJS server plugin loaded by SillyTavern
st-plugin/tests/        Jest unit tests (auto-discovered by jest.config.cjs)
st-plugin/tools/        Manual test helpers — NOT picked up by Jest testMatch globs
st-extension/src/       Extension source (ESM; imports from shared/tool-defs.js)
st-extension/index.js   Committed esbuild bundle — what ST actually loads; rebuild with npm run build:extension
st-extension/tests/     Extension tests (manual/Playwright)
oc-plugin/              OpenClaw plugin (TypeScript); compiled to oc-plugin/dist/index.js
skills/character-bridge/ OC skill definitions — YAML frontmatter + Markdown
sillytavern/            Git submodule — ST vendor checkout for local dev
data/                   Runtime data (bridge token, character-links.json)
```

### OC plugin deployment — critical

OC loads the plugin from `~/.openclaw/extensions/openclaw-bridge/`, **not** from `oc-plugin/` in this repo. Changes to `oc-plugin/` are invisible to a running OC process until that installed copy is updated.

`dev-setup.sh` handles this by replacing the installed copy with a symlink to `oc-plugin/` (OC still needs a restart to pick it up). Always run `dev-setup.sh` when setting up a new checkout. After making changes to `oc-plugin/src/index.ts`, recompile with:

```bash
/path/to/openclaw/node_modules/typescript/bin/tsc --project oc-plugin/tsconfig.json
```

then restart OC. If an OC plugin fix appears to have no effect, check `~/.openclaw/extensions/openclaw-bridge/dist/index.js` — it may be a stale installed copy.

### Key files

| File | Purpose |
|---|---|
| `st-plugin/index.js` | Route registration, `init()` entry point, auth middleware |
| `st-plugin/session-manager.js` | In-memory client registry and pending request map; also owns HTTP polling queue |
| `st-plugin/ws-server.js` | WebSocket server; calls `sessionManager.registerClient()` on connect |
| `st-plugin/generator.js` | WebSocket dispatch to extension, request/response correlation |
| `st-plugin/link-state.js` | Persisted character → OC agent link config (`character-links.json`) |
| `st-plugin/chat-history.js` | JSONL read/write for ST chat files |
| `st-plugin/headless-service.js` | Playwright headless browser for background generation without UI |
| `st-extension/src/index.js` | Extension source: bootstrap, `generateForCharacter()` implementation |
| `shared/tool-defs.js` | `ACTION_TOOL_DEFS` + `ST_SIDE_TOOL_DEFS` — single source of truth for tool definitions |
| `skills/character-bridge/SKILL.md` | OC tool schemas (`generate_response`, `log_action`) and agent instructions |

## Critical Architecture Decisions

### Generation lives in the browser extension, not the plugin

`Generate('quiet', { force_chid })` is only accessible from ST's browser context via `SillyTavern.getContext()`. The plugin cannot call it server-side. The WebSocket round-trip — plugin receives HTTP → sends to extension via WS → extension calls `Generate()` → sends response back → plugin returns to caller — is intentional and required. Do not attempt to move generation into the plugin or call ST's LLM endpoints directly; both approaches bypass ST's full prompt assembly pipeline (character card, lorebook, persona, author's notes, token budget).

### Headless service preference for generation

`session-manager.js:getClient()` always prefers clients registered with `isHeadless: true`. The user's browser is never used to process OC messages. If no headless client is available, generation falls back to HTTP polling (enqueued in `httpOutboundQueue`). The browser UI extension is a last resort, never first choice.

### `force_chid` enables multi-character generation

`generateForCharacter()` passes `force_chid` to `Generate()` targeting a specific character by index regardless of which character is active in the ST UI. `characters.findIndex(c => c.name === characterName)` maps name to chid. If `-1`, return a clean error — do not proceed.

### `Generate('quiet', ...)` does not write history

Quiet generation returns text without saving to chat history or rendering in ST's UI. History writes are a separate explicit step in the `/generate` handler (`appendExternalChatToHistory()` after the extension returns). Do not add history writes inside the extension's `generateForCharacter()`. If messages appear duplicated in ST, a double-write was introduced — check both locations.

### Trust labels are injected by code, not inferred by the model

Every `/generate` request includes a `user_id`. The plugin compares it against `owner_user_ids` from link-state and prepends `[OWNER]` or `[GUEST]` to the message before generation. This is hard enforcement — a guest message cannot escalate to owner trust regardless of content. Never make the label optional or let message content influence which label it receives.

### No intermediary process

OC calls the plugin directly via HTTP. There is no Python bridge, no adapter layer. References to `bridge.py`, `characters.yaml`, or channel adapters are from an earlier architecture and should be removed.

## State and Persistence

**Link state:** Persisted JSON via `link-state.js`. Maps character name → `{ oc_agent_id, active, owner_user_ids }`. Keep the schema stable — changes require migration of existing `character-links.json`.

**Chat history:** Per-character JSONL files under ST's data path. Always use `appendExternalChatToHistory()`. Use `ExternalChat` as the source label, not provider-specific names like `Discord`. History writes use a locking mechanism — do not bypass it.

**Session manager:** Entirely in-memory — lost on plugin restart. Tests mock this module. Do not add persistence to it.

## Configuration

| Variable | Purpose |
|---|---|
| `OPENCLAW_BRIDGE_AUTH_TOKEN` | Bearer token for plugin endpoint auth |
| `OPENCLAW_BRIDGE_TOKEN` | Alias used by OC skill env config |
| `OPENCLAW_BRIDGE_WS_PORT` | WebSocket server port (default 8765) |
| `OPENCLAW_BRIDGE_LINKS_PATH` | Optional override for character-links.json path |
| `OPENCLAW_BRIDGE_ALLOW_FALLBACK` | `true` enables mock generator fallback (dev only, never production) |
| `OPENCLAW_BRIDGE_ENABLE_HEADLESS` | Set to `false` to disable headless Playwright service |
| `OPENCLAW_BRIDGE_ST_URL` | URL for headless service to connect to ST (default `http://localhost:8000`) |
| `OPENCLAW_BRIDGE_WAIT_FOR_CLIENT_MS` | How long to wait for a WS client before falling back to HTTP polling (default 5000) |

Dev token auto-loaded from `data/openclaw-bridge/bridge-token.txt` when env vars are unset.

**CSRF:** Set `disableCsrf: true` in ST's `config.yaml` for local dev. Plugin endpoints use Bearer token auth as their security layer.

## Testing Strategy

**Unit tests (Jest):** Mock the WebSocket and session manager. Plugin HTTP handlers, link-state, chat-history, and session-manager are fully unit-testable without ST running. Add new routes at the end of `init()` — test router mocks assume stable route registration order and capture the last-registered POST handler for `/generate`.

**Mock OpenClaw client (primary E2E tool):** `st-plugin/tools/mock-openclaw.js` simulates the full pipeline without real OC infrastructure. Run interactively (`--test-scenario`) or send single messages (`--character Frog --message "Ribbit!" --user-id discord:user123`). Token auto-loaded from `data/openclaw-bridge/bridge-token.txt`. Use this for all end-to-end validation.

**Fake extension:** `st-plugin/tools/fake-extension.js` connects to the WebSocket and echoes a fixed response. Use it with curl to test the plugin round-trip (history writes, trust labels, concurrency) without a real browser or LLM.

**Playwright E2E:** Reserved for things that genuinely require a browser: UI panel rendering, status indicator updates, verifying a real `Generate()` call appears in ST's chat UI. Keep the suite minimal.

**LLM strategy:** Unit tests mock all LLM responses. Integration tests use Ollama locally (`ollama pull qwen2.5:3b`) or Gemini Flash (free tier). The WebSocket generation timeout is 900000ms (15 minutes) — do not reduce it; local Ollama models can take 5–10 minutes to respond.

## Adding a new character action tool (R5)

Character action tools let the ST brain instruct the OC body to take outbound actions during generation. They work on two paths:

- **ST UI path**: the character responds natively in the ST chat UI; ST's built-in function calling fires the tool.
- **OC/Discord path**: `Generate('quiet', ...)` excludes tool calling, so the tool schema is injected as text into the prompt instead. The LLM may output `<action>` blocks which the `/generate` handler parses and strips server-side before returning `pending_actions` to OC.

Adding a new tool requires changes in three files:

### 1. Register the tool in `st-plugin/action-tools.js` (source of truth)

Add an entry to `ACTION_TOOLS`:

```js
{
    type: 'my_action',
    description: 'What this action does and when to use it.',
    parameters: [
        { name: 'param_one', description: 'What this parameter is' },
    ],
},
```

The `type` string must match the `case` label in step 3. This drives the prompt injection on the OC path — the LLM sees the description and parameter list as text.

### 2. Register the tool in `st-extension/index.js` (ST UI path)

Inside `registerBridgeTools()`, add a new `context.registerFunctionTool(...)` call:

```js
context.registerFunctionTool({
    name: 'openclaw_my_action',
    displayName: 'Human-readable name',
    description: 'What this tool does and when to use it.',
    parameters: {
        type: 'object',
        properties: {
            param_one: { type: 'string', description: 'What this param is' },
        },
        required: ['param_one'],
    },
    stealth: true,
    action: async (params) => {
        queueCharacterAction('my_action', params);
        return { queued: true };
    },
});
```

`queueCharacterAction` reads `ctx.characterId` from the ST context to scope the action to the correct character — no additional scoping needed.

### 3. Implement execution in `oc-plugin/src/index.ts`

Add a new `case` in the `switch` inside `executeCharacterActions`:

```ts
case "my_action": {
    // Use api.config (OpenClawConfig) and api.runtime for OC SDK access.
    const adapter = await api.runtime.channel.outbound.loadAdapter(ctx.channelId);
    if (!adapter?.sendText) { outcome = "no outbound adapter"; break; }
    await adapter.sendText({
        cfg: api.config,
        to: String(action.param_one ?? ""),
        text: String(action.content ?? ""),
        ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
    });
    outcome = "sent";
    break;
}
```

**OC SDK key points:**
- `api.config` — the `OpenClawConfig` object; required by all `ChannelOutboundContext` calls
- `api.runtime.channel.outbound.loadAdapter(channelId)` — returns a `ChannelOutboundAdapter | undefined`; always guard with `?.sendText` before calling
- `ctx.channelId` — full OC channel account ID (e.g. `"discord-mybotname"`); routes to the same account that received the inbound message
- `ctx.accountId` — optional multi-account discriminator; pass through so multi-account deployments route to the right bot
- For plain text messaging to a channel or user, use the existing `send_message` tool rather than adding a new one — it handles all platforms via pre-resolved `action.channel_id` and `action.target`/`action.recipient`. Only add a new tool for capabilities `sendText` cannot express (e.g. reactions, attachments, thread replies).

The `log-action` call (R5.5) after the switch already records the outcome to ST chat history — no changes needed for logging. Guest action blocking (R5.4) is enforced in the `/generate` handler before `pending_actions` is returned to OC.

## Requirements

`docs/planning-requirements.md` is the go/no-go document for v1.0. It defines R1–R9 across channel communication, character fidelity, memory, trust/security, outbound actions, output formatting, multi-character isolation, and installation. R9 lists open problems — R9.1, R9.2, and R9.3 are all resolved. R10 (autonomous heartbeat/persistent presence) is implemented and E2E tested. R5 (outbound character actions) is implemented — OC path uses `<action>` block injection/parsing; ST UI path uses native `registerFunctionTool`. R11 (character memory management via lorebook on the OC path) is the next target — ST UI path already works; OC path needs the same injection/parsing treatment as R5, with a routing fork to `stSideActions` instead of `pendingActions`. Review it before deciding an implementation approach is complete.

## Workflow

Do not create git commits or push changes unless explicitly asked. The repository maintainer handles all commits and pushes.

All implementation work must happen on a feature branch, not directly on `main`. Branch protection requires both `Unit tests` and `E2E fast tier` CI checks to pass before a PR can be merged. At the start of any new issue or task, create a branch (e.g. `feat/issue-42` or `fix/warnings`) before writing any code.

## Conventions

- Route registration order in `index.js` matters for test mocks — add new routes at the end, with `log-action` registered before `generate`
- Plugin test helpers belong in `st-plugin/tools/` or `st-plugin/tests/helpers/` — not in locations matching Jest's `testMatch` globs
- Minimize global side-effects in `init()` so tests can mock modules and call handlers directly
- The extension is browser code — UI integration requires manual verification in the ST dev server. Pure logic (functions that don't reference browser globals) must be tested using the pure-copy pattern in `st-extension/tests/extension.test.js`: copy the function, parameterise away any globals, and test in isolation
- Do not create git commits or push changes without explicit instruction from the repository maintainer
