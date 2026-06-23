# Docker E2E testing

The Docker E2E suite proves the complete message path with only two things mocked: the LLM and the fake channel (a synthetic Discord stand-in). Everything else — OC gateway, character-bridge skill, ST plugin, headless Playwright, trust label enforcement, history writes — runs from real code inside Docker containers.

There are three Docker tiers depending on how much infrastructure you have available:

| Tier | Command | CI | Services | Mock depth | When to use |
|------|---------|-----|----------|------------|-------------|
| **Fast** | `npm run test:e2e:fast` | ✅ | ST + fake-extension | extension echo | Every PR; quick regression; no OC repo needed |
| **Browser** | `npm run test:e2e:browser` | ✅ | ST + fake-extension + Chromium | extension echo | Every PR; validates real browser extension code |
| **Full** | `npm run test:e2e:full` | ❌ local only | ST + OC gateway + qa-bus + fake-openai | LLM only | Pre-release; OC integration changes; requires `~/projects/openclaw` |

---

## Fast tier

Tests ST, the plugin, and the headless WebSocket round-trip. The extension is replaced by `fake-extension.js` (an echo server) that returns a canned response over the WebSocket — no real LLM is involved. No OC repo or OC binary required.

```bash
npm run test:e2e:fast
```

This command runs `docker compose` with `docker/docker-compose.yml`, waits for services to be healthy, then executes the Jest suite inside the `test-runner` container (22 tests).

**Services:**

| Container | Image | Role |
|-----------|-------|------|
| `sillytavern` | built from `docker/sillytavern/` | ST with plugin + headless service |
| `fake-extension` | built from `docker/fake-extension/` | WebSocket echo server |
| `test-runner` | built from `docker/test-runner/` | Jest suite |

**What it covers:**

- Plugin health and WS client registration
- Character linking via REST and via `link-character.sh` script
- Generate round-trip (response flows end-to-end through the fake extension)
- Trust label injection: `[OWNER]`, `[GUEST]`, escalation resistance
- Heartbeat path (R10): `is_heartbeat: true` adds `[HEARTBEAT]` prefix, no trust label
- `write_memory` ST-side action (R11): lorebook entry created and readable via `/characters/:name/memory`
- Character OC-side actions: `actions` array returned to caller (owner only; guests get empty array)
- Multi-character isolation: TestBot and Narrator generate independent responses
- `setup.sh --st-path`: script exits 0, copies plugin files, generates a bridge token

---

## Browser tier

Tests the real `st-extension` code — the only tier that loads the actual extension JavaScript in a Chromium browser and validates the full WebSocket round-trip. The fast tier uses `fake-extension` (an echo server) which bypasses the extension entirely; the browser tier catches bugs that only surface when the real extension code runs.

```bash
npm run test:e2e:browser
```

**Services:**

| Container | Image | Role |
|-----------|-------|------|
| `sillytavern` | shared with fast tier | ST with plugin (headless Playwright service disabled) |
| `fake-extension` | shared with fast tier | WebSocket echo server (provides a WS client so non-browser tests in the stack still work) |
| `browser-test-runner` | built from `docker/browser-test-runner/` | Playwright + Chromium; loads and exercises `st-extension/index.js` |

**What it covers:**

- Extension WS registration and connection handshake
- `Generate('quiet', { force_chid })` called with correct parameters
- Same-character generate requests are serialized (no concurrent generation for one character)
- Trust label (`[OWNER]`/`[GUEST]`) present in the prompt passed to `Generate()`
- Notification panel renders in the ST UI on `POST /test-notify`
- Management panel injects into the ST character editor

**Why the browser registers as headless:**

Playwright drives Chromium non-interactively, making it functionally a headless client. The `bootExtension` helper sets `globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE = 'headless'` before loading the extension so `session-manager.getClient()` picks it up (it only selects headless clients, never the user's interactive browser — this is by design to prevent UI hijacking).

---

## Full tier

Tests the entire message path: a synthetic inbound message enters via `qa-bus` (the fake channel), OC picks it up via `qa-channel`, invokes the `character-bridge` skill, which calls the ST plugin, which dispatches to headless Playwright, which calls `fake-openai`, and the response travels back through OC to `qa-bus` where the test asserts on it.

```bash
# One-time: build the OC image (requires openclaw repo at ~/projects/openclaw)
bash docker/full/build-oc.sh

# Run the full tier
npm run test:e2e:full
```

This command runs `docker compose` with `docker/full/docker-compose.full.yml` (24 tests, all pass).

**Services:**

| Container | Image | Role |
|-----------|-------|------|
| `sillytavern-full` | built from `docker/full/sillytavern/` | ST with headless Playwright extension |
| `openclaw` | `openclaw-bridge:oc-full` (pre-built) | OC gateway + qa-channel + character-bridge skill |
| `qa-bus` | built from `docker/full/qa-bus/` | Fake channel (message bus) |
| `fake-openai` | built from `docker/fake-openai/` | OpenAI-compatible mock LLM for both ST and OC's agent |
| `full-test-runner` | built from `docker/full/test-runner/` | Jest suite |

**What it covers (in addition to what the fast tier proves):**

- Full message path: `qa-bus → OC → character-bridge skill → ST plugin → headless Playwright → fake-openai → qa-bus`
- Trust label enforcement end-to-end with a real OC agent identity
- Multiple sequential messages handled without collision
- ST chat history written after generation
- Heartbeat fires from OC plugin: `is_heartbeat: true` request reaches ST, generates response, posts to qa-bus (R10)
- Lorebook memory write + read via `POST /characters/:name/memory` and `GET /characters/:name/memory` (R11 storage path)
- `link-character.sh` round-trip: `--unlink` removes the character link, `link-character.sh` restores it
- Headless reconnect after ST restart (R8.4): `docker restart sillytavern-full`, wait for headless to come back, assert generation still works (240s timeout)
- `verify.sh` health check: runs against the initial setup and again after the uninstall → reinstall → restart lifecycle, asserting 0 failures each time

**Real install simulation.** The full tier is uniquely valuable because it replicates a real user install from scratch:

- The ST container starts with bare ST; `setup.sh` runs as an entrypoint and installs the plugin + extension before ST starts
- The OC container starts with bare OC; `openclaw plugins install /repo/oc-plugin` runs before the gateway starts
- Character links are created by a one-shot `link-setup` service that runs `link-character.sh` — no pre-seeded config
- If any of these steps is broken, the tests fail, answering definitively: "does a clean install work?"

### Building the OC image

`build-oc.sh` builds two Docker images from the OC repo:

1. `openclaw-bridge:oc-qa` — OC with `qa-channel` compiled in
2. `openclaw-bridge:oc-full` — extends `oc-qa` with the `character-bridge` skill

The build must include `qa-lab` alongside `qa-channel` in `OPENCLAW_EXTENSIONS`. This is non-obvious: OC's `copy-bundled-plugin-metadata.mjs` removes `dist/extensions/qa-channel/` unless `OPENCLAW_BUILD_PRIVATE_QA=1` is set, and the OC Dockerfile only sets that variable when `qa-lab` appears in the extensions list. Without it, `qa-channel` is silently absent and OC starts but ignores messages.

```bash
# What build-oc.sh does internally:
docker build \
  -t openclaw-bridge:oc-qa \
  --build-arg OPENCLAW_EXTENSIONS="qa-channel,qa-lab" \
  -f "${OC_REPO}/Dockerfile" \
  "${OC_REPO}"
```

You only need to rebuild this image when the OC repo changes or when `skills/character-bridge/SKILL.md` changes.

### OC config (`docker/full/openclaw/openclaw.json`)

The `qa-channel` plugin schema is `additionalProperties: false` with no defined properties — it accepts only the fields listed below. Adding Discord-style fields like `dmPolicy`, `groupPolicy`, or `allowFrom` will crash OC on startup.

Valid qa-channel config:
```json
"qa-channel": {
  "enabled": true,
  "baseUrl": "http://qa-bus:15000",
  "botUserId": "openclaw",
  "botDisplayName": "OpenClaw Bridge",
  "pollTimeoutMs": 250
}
```

---

## Directory structure

```
docker/
├── docker-compose.yml              Fast + browser tier compose file
├── sillytavern/                    ST Dockerfile + config (fast + browser)
│   ├── Dockerfile
│   └── config.yaml                 securityOverride: true required for Docker
├── fake-extension/                 WebSocket echo server (fast + browser)
├── fake-openai/                    OpenAI-compatible mock LLM (full tier; ST + OC)
├── test-runner/                    Fast-tier Jest suite
│   └── e2e.test.js
├── browser-test-runner/            Browser-tier Playwright runner
│   └── Dockerfile                  node:22 + playwright install chromium --with-deps
└── full/
    ├── docker-compose.full.yml     Full tier compose file
    ├── build-oc.sh                 Builds openclaw-bridge:oc-qa and :oc-full
    ├── sillytavern/                ST Dockerfile for full tier (Alpine + system Chromium)
    │   ├── Dockerfile
    │   └── config.yaml
    ├── openclaw/                   OC image layer (adds character-bridge skill)
    │   ├── Dockerfile
    │   └── openclaw.json           OC runtime config
    ├── qa-bus/                     Fake channel message bus
    └── test-runner/                Full-tier Jest suite
        └── full-e2e.test.js
```

---

## Implementation notes

**Alpine base image.** Both ST Dockerfiles use Alpine Linux. Use `apk add chromium` (not `apt-get`) and set `CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser`. The headless service in `st-plugin/headless-service.js` reads this env var to pass `executablePath` to Playwright.

**`securityOverride: true`.** Required in ST's `config.yaml` when running in Docker. Newer ST versions refuse to start if they detect they're not on localhost and this flag is absent.

**Test-runner image caching.** Docker caches the test-runner image layer. After editing a test file, explicitly rebuild before running:

```bash
docker compose -f docker/full/docker-compose.full.yml build full-test-runner
```

**`qa-bus` as the fake channel.** The qa-bus exposes `/v1/inbound/message` (inject a message), `/v1/state` (read all events including outbound), and `/v1/reset` (clear between tests). Tests poll `/v1/state` waiting for `outbound-message` events to appear — that's how they verify OC sent a response.

**`fake-openai` role.** One OpenAI-compatible mock serves both ST and OC's agent (both speak the OpenAI API), replacing the old fake-ollama (ST) + mock-llm (OC agent) split. ST points at it as a `custom` chat-completion source; OC points at it as an `openai-completions` provider. It is runtime-primeable (`/scenario`, `/reset`, `/error-once`, `/last-prompt`, `/pending-count`) so tests assert on unique sentinels instead of sleeping. In the normal path the OC bridge plugin intercepts the inbound message and calls ST `/generate` directly (ST brain drives, OC body executes), so the agent-LLM side of the mock only fires on the true fallback (no linked character) or when an ST character explicitly drives the OC agent — in which case it returns a `generate_response` tool call.

**Headless client wait.** `beforeAll` in `full-e2e.test.js` polls `/health` until `headless.isRunning === true` before running any tests. ST's headless Playwright service takes 15–30 seconds to launch Chromium inside the container and connect via WebSocket. The setup timeout is 5 minutes.

---

## When to run which tier

- **Every PR (automatic)** — GitHub Actions runs unit tests, the fast tier, and the browser tier on every push and pull request. All three must pass before a PR can be merged. No action required from you.
- **Local fast or browser run** — `npm run test:e2e:fast` / `npm run test:e2e:browser`. Useful when you want to reproduce a CI failure locally or do a quick regression check before pushing.
- **Before release (manual)** — run the full tier locally. It validates OC's skill dispatch, trust label injection, and the complete inbound→outbound message path. Cannot run in CI: the full tier requires the private OC repo to build `openclaw-bridge:oc-full`, which is not available on GitHub-hosted runners.
- **Debugging a generation issue** — the full tier is a clean isolated environment to bisect: if it passes here but fails in production, the bug is in configuration or environment, not in code.
- **Adding a new character action tool** — add a test to `full-e2e.test.js` that sends a message triggering that tool and asserts on the qa-bus outbound event or ST state.
- **Adding a browser extension feature** — add a test to `st-plugin/tests/e2e/openclaw-bridge.e2e.js` (browser tier); use the `bootExtension` helper to load the extension in Chromium and interact via `page` and `request`.
