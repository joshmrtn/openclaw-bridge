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

# Wire plugin into local ST checkout for development
bash ./dev-setup.sh

# Generate bridge token and set up data directory
./setup.sh
```

## Repository Structure

```
st-plugin/              Node.js CommonJS server plugin loaded by SillyTavern
st-plugin/tests/        Jest unit tests (auto-discovered by jest.config.cjs)
st-plugin/tools/        Manual test helpers — NOT picked up by Jest testMatch globs
st-extension/           Browser JS extension loaded by SillyTavern's extension system
st-extension/tests/     Extension tests (manual/Playwright)
skills/character-bridge/ OC skill definitions — YAML frontmatter + Markdown
sillytavern/            Git submodule — ST vendor checkout for local dev
data/                   Runtime data (bridge token, character-links.json)
```

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
| `st-extension/index.js` | Extension bootstrap, `generateForCharacter()` implementation |
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

## Requirements

`docs/planning-requirements.md` is the go/no-go document for v1.0. It defines R1–R9 across channel communication, character fidelity, memory, trust/security, outbound actions, output formatting, multi-character isolation, and installation. R9 lists open problems that must be resolved before v1.0 — notably R9.1 (non-active character generation without UI disruption) and R9.2 (headless operation). Review it before deciding an implementation approach is complete.

## Workflow

Do not create git commits or push changes unless explicitly asked. The repository maintainer handles all commits and pushes.

## Conventions

- Route registration order in `index.js` matters for test mocks — add new routes at the end, with `log-action` registered before `generate`
- Plugin test helpers belong in `st-plugin/tools/` or `st-plugin/tests/helpers/` — not in locations matching Jest's `testMatch` globs
- Minimize global side-effects in `init()` so tests can mock modules and call handlers directly
- The extension is browser code — verify UI integration manually by loading in the ST dev server; do not unit-test browser globals
- Do not create git commits or push changes without explicit instruction from the repository maintainer
