# OpenClaw Bridge — Copilot Instructions

## Project Purpose

This project bridges OpenClaw (OC) and SillyTavern (ST) so that AI companion characters maintain a single canonical identity across all communication channels. ST is the brain — it holds character cards, lorebooks, memory, and runs the LLM pipeline. OC is the body — it handles Discord, Telegram, WhatsApp, and autonomous scheduled actions natively.

The core insight: OC character agents install the `character-bridge` skill, which teaches them to POST incoming messages to the ST plugin rather than responding directly. The plugin routes those messages through ST's full generation pipeline via the browser extension, ensuring every response — regardless of channel — uses the character's complete ST context.

---

## Runtimes and Stack

- **Plugin runtime:** Node.js, CommonJS modules
- **Test runner:** Jest (unit), Playwright (e2e)
- **Extension:** Browser JavaScript, loaded by SillyTavern's extension system
- **Skill:** YAML frontmatter + Markdown, installed into OC agent workspaces
- **Config:** See `package.json`, `jest.config.cjs`

---

## Repository Structure

```
st-plugin/              Node.js server plugin — HTTP endpoints and WebSocket server
st-plugin/tests/        Jest unit tests
st-plugin/tools/        Manual test helpers (not picked up by Jest testMatch globs)
st-extension/           Browser UI extension loaded by SillyTavern
st-extension/tests/     Extension tests (manual/Playwright)
skills/character-bridge/ OC skill definitions and operator README
sillytavern/            ST submodule — vendor app and local plugin mirror for dev
```

### Key files

| File | Purpose |
|---|---|
| `st-plugin/index.js` | Route registration, `init()` entry point |
| `st-plugin/generator.js` | WebSocket dispatch to extension, request/response correlation |
| `st-plugin/session-manager.js` | In-memory pending request map (ephemeral) |
| `st-plugin/link-state.js` | Persisted character → OC agent link config |
| `st-plugin/chat-history.js` | JSONL read/write for ST chat files |
| `st-extension/index.js` | Extension bootstrap, `generateForCharacter()` implementation |
| `st-extension/index.html` | Extension UI entry point |
| `st-extension/manifest.json` | ST extension metadata |
| `skills/character-bridge/SKILL.md` | OC tool schemas and agent instructions |

---

## Critical Architecture Decisions

These are not simplification opportunities. Each exists for a specific reason. Changing them without understanding the reason will break the system in ways that are hard to debug.

### Generation lives in the extension, not the plugin

`Generate('quiet', { force_chid })` is only accessible from SillyTavern's browser context via `SillyTavern.getContext()`. It is not available server-side. The plugin cannot call it directly.

The WebSocket round-trip — plugin receives HTTP request → sends to extension via WebSocket → extension calls `Generate()` → sends response back → plugin returns to caller — is intentional and required, not a simplification opportunity.

Do not attempt to move generation into the plugin. Do not attempt to call ST's LLM endpoints directly from the plugin. Both approaches bypass ST's full prompt assembly pipeline (character card, lorebook, persona, author's notes, injection positions, token budget management) and produce responses that are not fully in character.

### `force_chid` is what makes multi-character work

`generateForCharacter()` passes `force_chid` to ST's `Generate()` to target a specific character by index regardless of which character is currently active in ST's UI. This is what allows Gerard to respond on Discord while the user is actively chatting with Edward in ST — no character switching, no UI disruption.

`characters.findIndex(c => c.name === characterName)` is how the name maps to a chid. If this returns -1 the character doesn't exist in ST — return a clean error, do not proceed.

### `Generate('quiet', ...)` does not write history

Quiet generation returns the response text but does not render it in the ST UI and does not save it to chat history. History writes are an explicit separate step, handled by `appendExternalChatToHistory()` in the plugin's `/generate` handler after the extension returns a response.

Do not add a history write inside the extension's `generateForCharacter()`. Do not skip the history write in the plugin handler. If you see duplicated messages in ST, a double-write has been introduced — check both locations.

### Trust labels are structural, not instructional

Every `/generate` request includes a `user_id`. The plugin compares this against `owner_user_ids` in link-state for that character and prepends either `[OWNER]` or `[GUEST]` to the message before passing it to generation. This happens at the plugin layer — before the LLM ever sees the message.

This is hard enforcement. A guest message cannot escalate to owner trust regardless of its content, because the label is injected by code, not inferred by the model. Never make the label optional, never let the content of a message influence which label it receives, and never remove this step.

### OC calls the plugin directly — there is no bridge process

OC handles all channel integrations (Discord, Telegram, WhatsApp, etc.) natively. Character agents install the `character-bridge` skill which defines structured tool schemas. OC calls `POST /generate` and `POST /log-action` directly via HTTP using these tools. There is no Python bridge, no adapter layer, no intermediary process. If you see references to `bridge.py`, `characters.yaml`, or channel adapters in code, they are from an earlier architecture and should be removed.

---

## State and Persistence

### Link state

Persisted JSON via `st-plugin/link-state.js`. Maps character name → `{ oc_agent_id, active, owner_user_ids }`. Keep the schema stable — changes require migration of existing `character-links.json` files.

```json
{
  "Gerard": {
    "oc_agent_id": "gerard",
    "active": true,
    "owner_user_ids": ["discord:123456789012345678"]
  }
}
```

### Chat history

Per-character JSONL files under SillyTavern's data path. Use `appendExternalChatToHistory()` for all external-channel messages. Writes must be atomic to avoid corruption if ST is also writing to the same file. Use the existing locking mechanism in `chat-history.js` — do not bypass it.

Label external messages consistently: use `ExternalChat` as the source identifier rather than provider-specific names like `Discord` or `Telegram`. This keeps history readable regardless of which channel the message came from.

### Session manager

In-memory map of pending WebSocket requests in `st-plugin/session-manager.js`. Treated as ephemeral — data is lost on plugin restart. Tests mock this module. Do not add persistence to it.

---

## Configuration and Secrets

| Variable | Purpose |
|---|---|
| `OPENCLAW_BRIDGE_AUTH_TOKEN` | Bearer token for plugin endpoint auth |
| `OPENCLAW_BRIDGE_TOKEN` | Alias used by OC skill env config |
| `OPENCLAW_BRIDGE_WS_PORT` | WebSocket server port (default 8765) |
| `OPENCLAW_BRIDGE_LINKS_PATH` | Optional override for character-links.json path |

Dev setup writes the token to `data/openclaw-bridge/bridge-token.txt` during initialization.

---

## CSRF

ST's CSRF middleware blocks external POST requests by default. For development, set `disableCsrf: true` in ST's `config.yaml`. The plugin's own endpoints use Bearer token auth as their security layer — CSRF on top is redundant for API endpoints not accessed from a browser session.

---

## How OC Uses the Plugin

OC character agents install `skills/character-bridge/SKILL.md` into their workspace. The YAML frontmatter defines two tools with typed schemas:

- `generate_response` — POST to `/generate`, returns character response text
- `log_action` — POST to `/log-action`, writes autonomous action to ST chat history

The markdown body provides behavioral instructions: always call `generate_response` before replying, never compose responses directly, respect trust tier labels, call `log_action` after autonomous actions.

OC's structured tool calling is more reliable than prose instructions in AGENTS.md because the model sees a typed function definition rather than natural language it might interpret loosely.

---

## Testing Strategy

### Unit tests (Jest)

Run with `npm test` or `npm test -- st-plugin` for plugin only.

Tests mock the WebSocket and session manager. The plugin's HTTP handlers, link-state, chat-history, and session manager should be fully unit-testable without ST running. When adding routes, maintain stable ordering for test router mocks — tests assume the last-registered POST handler for `/generate`.

Test helpers belong in `st-plugin/tools/` or `st-plugin/tests/helpers/`. Do not put helpers in locations that match Jest's `testMatch` globs.

### Fake extension (integration testing without a browser)

The plugin's WebSocket protocol can be tested without a real browser by running a fake extension that connects to the WebSocket and responds to generate requests with a fixed string:

```javascript
// st-plugin/tools/fake-extension.js
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8765');

ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type === 'generate') {
        ws.send(JSON.stringify({
            type: 'generate_response',
            requestId: msg.requestId,
            response: `[FAKE RESPONSE for ${msg.character}]`
        }));
    }
});
console.log('Fake extension connected');
```

Run this alongside ST, then fire curl commands at the plugin endpoints. This lets you test the full plugin round-trip including history writes, trust label injection, and concurrent request handling without needing a real browser or LLM.

### E2E tests (Playwright)

Reserve for things that genuinely require a browser: UI panel rendering, status indicator updates, and verifying that a real `Generate()` call goes through and the response appears in ST's chat UI. Keep the E2E suite minimal — one happy-path test is enough to catch regressions in the extension without a slow full suite.

### Skill validation

The skill YAML frontmatter can be validated in CI without OC running:

```bash
# package.json scripts
"test:skill": "node tools/validate-skill.js skills/character-bridge/SKILL.md"
```

This catches malformed tool schemas before anyone tries to install them.

### LLM strategy for tests

- **Unit tests:** mock all LLM responses — never hit a real API in unit tests
- **Integration tests:** use Ollama locally (`ollama pull qwen2.5:3b`) or Google AI Studio free tier (Gemini Flash, 1500 req/day). Quality does not matter for pipeline tests — any coherent response confirms the round-trip works
- **Manual character fidelity checks:** done by hand with a real model; not automated

---

## Conventions

- Use `ExternalChat` as the source label for external-channel messages, not provider-specific names
- Keep history writes idempotent — if a write fails and is retried, the result should be the same as a single successful write
- Minimize global side-effects in `init()` so tests can mock modules and call handlers directly
- Plugin test router mocks assume stable route registration order — add new routes at the end
- The extension is browser code — verify UI integration manually by loading in the SillyTavern dev server; do not attempt to unit-test browser globals