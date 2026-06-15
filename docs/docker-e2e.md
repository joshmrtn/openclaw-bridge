# Docker E2E testing

The Docker E2E suite proves the complete message path with only two things mocked: the LLM and the fake channel (a synthetic Discord stand-in). Everything else — OC gateway, character-bridge skill, ST plugin, headless Playwright, trust label enforcement, history writes — runs from real code inside Docker containers.

There are two tiers depending on how much infrastructure you have available:

| Tier | Services | Mock depth | When to use |
|------|----------|------------|-------------|
| **Fast** | ST + fake-extension + fake-ollama | LLM + extension echo | CI, quick regression, no OC repo needed |
| **Full** | ST + OC gateway + qa-bus + mock-llm + fake-ollama | LLM only | Pre-release, OC integration changes, debugging the full path |

---

## Fast tier

Tests ST, the plugin, and the headless WebSocket round-trip. The extension is replaced by `fake-extension.js` (an echo server), and `fake-ollama` returns a canned LLM response. No OC repo or OC binary required.

```bash
npm run test:e2e:fast
```

This command runs `docker compose` with `docker/docker-compose.yml`, waits for services to be healthy, then executes the Jest suite inside the `test-runner` container (19 tests).

**Services:**

| Container | Image | Role |
|-----------|-------|------|
| `sillytavern` | built from `docker/sillytavern/` | ST with plugin + headless service |
| `fake-extension` | built from `docker/fake-extension/` | WebSocket echo server |
| `fake-ollama` | built from `docker/fake-ollama/` | Returns fixed LLM text |
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

## Full tier

Tests the entire message path: a synthetic inbound message enters via `qa-bus` (the fake channel), OC picks it up via `qa-channel`, invokes the `character-bridge` skill, which calls the ST plugin, which dispatches to headless Playwright, which calls `fake-ollama`, and the response travels back through OC to `qa-bus` where the test asserts on it.

```bash
# One-time: build the OC image (requires openclaw repo at ~/projects/openclaw)
bash docker/full/build-oc.sh

# Run the full tier
npm run test:e2e:full
```

This command runs `docker compose` with `docker/full/docker-compose.full.yml` (17 tests, all pass).

**Services:**

| Container | Image | Role |
|-----------|-------|------|
| `sillytavern-full` | built from `docker/full/sillytavern/` | ST with headless Playwright extension |
| `openclaw` | `openclaw-bridge:oc-full` (pre-built) | OC gateway + qa-channel + character-bridge skill |
| `qa-bus` | built from `docker/full/qa-bus/` | Fake channel (message bus) |
| `mock-llm` | built from `docker/full/mock-llm/` | OpenAI Responses API mock (always calls `generate_response`) |
| `fake-ollama` | shared with fast tier | Returns fixed LLM text to ST |
| `full-test-runner` | built from `docker/full/test-runner/` | Jest suite |

**What it covers (in addition to what the fast tier proves):**

- Full message path: `qa-bus → OC → character-bridge skill → ST plugin → headless Playwright → fake-ollama → qa-bus`
- Trust label enforcement end-to-end with a real OC agent identity
- Multiple sequential messages handled without collision
- ST chat history written after generation
- Heartbeat fires from OC plugin: `is_heartbeat: true` request reaches ST, generates response, posts to qa-bus (R10)
- Lorebook memory write + read via `POST /characters/:name/memory` and `GET /characters/:name/memory` (R11 storage path)
- `link-character.sh` round-trip: `--unlink` removes the character link, `link-character.sh` restores it
- Headless reconnect after ST restart (R8.4): `docker restart sillytavern-full`, wait for headless to come back, assert generation still works (240s timeout)

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
├── docker-compose.yml              Fast tier compose file
├── sillytavern/                    ST Dockerfile + config (fast)
│   ├── Dockerfile
│   └── config.yaml                 securityOverride: true required for Docker
├── fake-extension/                 WebSocket echo server
├── fake-ollama/                    Fixed-response Ollama mock
├── test-runner/                    Fast-tier Jest suite
│   └── e2e.test.js
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
    ├── mock-llm/                   OpenAI Responses API mock (instructs OC to call generate_response)
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

**`mock-llm` role.** The mock-llm intercepts OC's LLM calls and always returns a tool call instructing OC to invoke `generate_response` (the character-bridge skill's main tool). This forces OC through the full skill execution path without requiring a real LLM or OpenClaw subscription.

**Headless client wait.** `beforeAll` in `full-e2e.test.js` polls `/health` until `headless.isRunning === true` before running any tests. ST's headless Playwright service takes 15–30 seconds to launch Chromium inside the container and connect via WebSocket. The setup timeout is 5 minutes.

---

## When to run which tier

- **Every PR (automatic)** — GitHub Actions runs the fast tier on every push and pull request. The CI workflow (`ci.yml`) also runs unit tests first; the fast tier only starts if they pass. No action required from you.
- **Local fast-tier run** — `npm run test:e2e:fast`. Useful when you want a quick regression check before pushing, or to debug a failing CI run locally.
- **Before release (manual)** — run the full tier locally. It validates OC's skill dispatch, trust label injection, and the complete inbound→outbound message path. Cannot run in CI: the full tier requires the private OC repo to build `openclaw-bridge:oc-full`, which is not available on GitHub-hosted runners.
- **Debugging a generation issue** — the full tier is a clean isolated environment to bisect: if it passes here but fails in production, the bug is in configuration or environment, not in code.
- **Adding a new character action tool** — add a test to `full-e2e.test.js` that sends a message triggering that tool and asserts on the qa-bus outbound event or ST state.
