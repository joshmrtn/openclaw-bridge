**Project Snapshot**
- **Purpose:** OpenClaw <> SillyTavern bridge implemented as an ST plugin plus an OpenClaw skill.
- **Primary runtimes:** Node.js (CommonJS) for plugin and tests; optional Playwright for e2e.

**Core Stack**
- **Runtime:** `node` (CommonJS modules). See [package.json](package.json).
- **Tests:** `jest` (unit) and `@playwright/test` (e2e). See [jest.config.cjs](jest.config.cjs).
- **ST Integration:** plugin under [st-plugin](st-plugin) and developer plugin copy under [sillytavern/plugins/openclaw-bridge](sillytavern/plugins/openclaw-bridge).
- **Skill / OC side:** skill files live under [skills/character-bridge](skills/character-bridge).

**Three Main Components**
- **`st-plugin/`** — the Node.js server plugin providing HTTP endpoints (`/generate`, `/log-action`, `/characters`, `/status`) and WebSocket integration for OpenClaw agents. Responsible for link-state, session management, generation handoff, and history writes.
- **`st-extension/`** — the browser UI extension that runs inside SillyTavern. This is a critical component: it implements `generateForCharacter()` (and related UI integration) which triggers the plugin endpoints and integrates responses into the UI. See [st-extension/index.js](st-extension/index.js) and [st-extension/index.html](st-extension/index.html).
- **`skills/character-bridge/`** — the OpenClaw skill definitions and tooling that OC agents install; these call the plugin endpoints (via `generate_response` and `log_action` tools) to interact with SillyTavern characters.

**Folder & Naming Idioms**
- **`st-plugin/`**: primary plugin implementation (routes, link-state, generator, session-manager, chat-history).
- **`skills/`**: OpenClaw skill definitions and README for operator guidance.
- **`sillytavern/`**: vendor app and local plugin mirror used for manual integration and dev-run.
- **`st-plugin/tests`**: Jest unit tests; helper utilities should live in `st-plugin/tests/helpers` or `st-plugin/tools` (non-test helpers).

**State & Persistence Patterns**
- **Link state:** persisted JSON via [st-plugin/link-state.js](st-plugin/link-state.js) (character → { oc_agent_id, active, owner_user_ids }). Keep schema stable.
- **Chat history:** per-character JSONL files under SillyTavern data path; helper: [st-plugin/chat-history.js](st-plugin/chat-history.js). Use `appendExternalChatToHistory()` for external-channel messages.
- **Session manager:** in-memory pending request map in [st-plugin/session-manager.js](st-plugin/session-manager.js). Treat as ephemeral; tests mock it.

**Configuration & Secrets**
- Env vars: `OPENCLAW_BRIDGE_AUTH_TOKEN` / `OPENCLAW_BRIDGE_TOKEN` (bearer), `OPENCLAW_BRIDGE_WS_PORT`, `OPENCLAW_BRIDGE_LINKS_PATH` (optional override).
- Token file: dev setup writes token to `data/openclaw-bridge/bridge-token.txt` during initialization scripts.

**Testing & Developer Workflow**
- Run unit tests: `npm test` or `npm test -- st-plugin` for plugin-only.
- Keep test helpers out of Jest's `testMatch` globs (use `st-plugin/tools` for manual helpers).
- When adding routes, ensure ordering is stable for the test router mocks (tests assume the last-registered POST handler for `/generate`).

- For `st-extension`: tests live under `st-extension/tests`. The extension is run as browser code — verify UI integration manually by loading `st-extension/index.html` in the SillyTavern dev server or running the vendor app locally. Key entry points:
	- `st-extension/index.js`: extension bootstrap and `generateForCharacter()` implementation.
	- `st-extension/index.html`: extension UI entry.
	- `st-extension/manifest.json`: extension metadata used by SillyTavern plugin loader.

**Conventions & Best Practices**
- Prefer generic naming for cross-channel content: `ExternalChat` rather than provider-specific names.
- Keep history writes idempotent: generator implementations may append history; plugin must avoid double-writes.
- Minimize global side-effects in `init()` so tests can mock modules and call handlers directly.

If this aligns, reply "approve" and I will commit. Tell me any additions or changes you want before committing.
