# Plan: Issue #191 — Full-tier E2E: Trust & Security Correctness

Branch: `feat/issue-191-trust-security-e2e`
Related: #171 (WS unauthenticated), #96 (CSRF bypass coverage)
This PR partially addresses #96 and fully closes #191 and #171.
This PR should land BEFORE #195 (which is blocked by this one per #190 ordering).

---

## Background

Issue #191 lists 5 coverage gaps to close with full-tier E2E tests. Gap 3 (WS
without auth) is blocked on issue #171, which requires a real code fix (not just
tests). Issue #96 (auth middleware CSRF bypass test coverage) overlaps with the
bearer token tests written in Phase 3.

The plan is broken into independent phases, each with a gate condition that can
be verified before moving to the next. Phases 1–5 are test-only; Phase 6 is a
combined code fix + test.

---

## Open design decisions resolved

**#171 "proper fix" approach**: require the Bearer token in the `register`
message for **headless clients only** (not UI clients). Rationale:

- Headless clients are the high-risk role: `session-manager.getClient()`
  prefers them for generation, so an attacker registering as headless can
  intercept prompts and forge responses.
- UI clients (browser extension) have no token at first connect (it arrives in
  the `welcome` response), so mandating it for UI would break them.
- An attacker sending `clientType: 'ui'` to bypass the headless check gets the
  lower-priority UI role — they can participate in HTTP polling fallback but
  never win the `getClient()` preference race over the real headless client.

**Bind address**: default `127.0.0.1`, configurable via new env var
`OPENCLAW_BRIDGE_WS_HOST`. Docker full-tier compose sets it to `0.0.0.0` so
the test-runner container can reach port 8765. In production (non-Docker), the
default `127.0.0.1` limits exposure to localhost.

**Token bootstrap for headless clients**: `headless-service.js` already uses
`addInitScript` to inject `OPENCLAW_BRIDGE_CLIENT_TYPE = 'headless'` (line 152).
We add a second injection: `OPENCLAW_BRIDGE_BRIDGE_TOKEN = bridgeToken`. The
extension reads `globalThis.OPENCLAW_BRIDGE_BRIDGE_TOKEN` in its register send
and includes it as the `token` field. UI clients never have this global set, so
their register message has no `token` field, and the server skips the check for
`clientType: 'ui'`.

**getAuthToken in headless-service**: `headless-service.js` does NOT currently
import `getAuthToken`. The cleanest approach: add a `bridgeToken` field to the
`start(options)` call signature, and have `index.js` pass `getAuthToken()` when
it calls `headlessService.start(...)`.

---

## Key file locations (confirmed by reading source)

```
docker/fake-ollama/server.js               Phase 1: add /last-prompt endpoint
docker/full/test-runner/full-e2e.test.js   Phases 2–6: all new describe blocks go here
docker/full/docker-compose.full.yml        Phase 6: add OPENCLAW_BRIDGE_WS_HOST=0.0.0.0
st-plugin/ws-server.js                     Phase 6: bind addr default + headless token check
st-plugin/headless-service.js              Phase 6: inject bridge token via addInitScript
st-plugin/index.js                         Phase 6: pass bridgeToken to headlessService.start()
st-extension/src/index.js                  Phase 6: include token in register message
st-extension/index.js                      Phase 6: committed bundle, rebuilt with npm run build:extension
```

---

## Full-e2e test file: infrastructure to reuse (do not re-derive)

Top-level constants already in `docker/full/test-runner/full-e2e.test.js`:
```js
const ST_URL        = process.env.ST_URL        || 'http://sillytavern-full:8000';
const QA_BUS_URL    = process.env.QA_BUS_URL    || 'http://qa-bus:15000';
const BRIDGE_TOKEN  = process.env.BRIDGE_TOKEN  || 'e2e-test-token';
const FAKE_OLLAMA_URL = process.env.FAKE_OLLAMA_URL || 'http://fake-ollama:11434';
const SILLYTAVERN_CONTAINER = process.env.SILLYTAVERN_CONTAINER || 'sillytavern-full';
// ST_WS_URL is NOT yet a top-level constant. It is defined inline inside
// the 'multiple headless clients' describe block. Phase 6 promotes it to
// a top-level constant and removes the inline definitions.
```

Module-level auth state (set in beforeAll):
```js
let stCsrfToken = '';
let stCsrfCookie = '';
```

Key helpers:
- `stFetch(path, opts)` — prepends `/api/plugins/openclaw-bridge`, adds Bearer
  auth + CSRF headers automatically. Use for happy-path calls.
- `fetch(url, opts)` — raw HTTP, NO auth headers added. Use to test 401/403 rejection.
- `post(url, body, headers)` — raw POST convenience wrapper.
- `waitFor(fn, opts)`, `sleep(ms)` — timing helpers.

`beforeEach` already calls `POST /reset` on both qa-bus and fake-ollama. This
clears the scenario queue. The Phase 1 `/last-prompt` reset also happens here
(Phase 1 adds it to the fake-ollama `/reset` handler).

---

## Phase 1 — Fake-ollama prompt capture

**Goal**: expose what the LLM actually received so trust label tests (Phase 2)
can inspect the raw prompt body.

### Change: `docker/fake-ollama/server.js`

Current module-level state (lines 32–36):
```js
const scenarioQueue = [];
let nextErrorOnce = false;
let pendingDelayCount = 0;
```

**Add two new state variables immediately after those lines:**
```js
let lastPromptRaw = null;
let lastPromptEndpoint = null;
```

In the `POST /api/generate` and `POST /api/chat` handler (starts around line
141), immediately after the line `const parsed = JSON.parse(body);`, add:
```js
lastPromptRaw = body;           // raw string from readBody(); not re-stringified
lastPromptEndpoint = path;      // '/api/generate' or '/api/chat'
```

In the `POST /reset` handler (around line 117), after `scenarioQueue.length = 0`:
```js
lastPromptRaw = null;
lastPromptEndpoint = null;
```

Add a new GET endpoint **before the final `res.writeHead(404)` fallthrough**:
```js
if (method === 'GET' && path === '/last-prompt') {
    if (lastPromptRaw === null) {
        return json(res, 404, { error: 'no prompt received yet' });
    }
    return json(res, 200, { raw: lastPromptRaw, endpoint: lastPromptEndpoint });
}
```

The `raw` field is the raw request body string. The `fetch()` helper in the
test file already parses JSON response bodies automatically, so tests do:
```js
const r = await fetch(`${FAKE_OLLAMA_URL}/last-prompt`);
expect(r.status).toBe(200);
expect(r.body.raw).toMatch(/\[OWNER\]/);
```

**Gate**: fake-ollama changes are isolated to one file. No other files change in
this phase. Verify: run unit tests (`npm test`) to confirm nothing is broken,
then begin Phase 2.

---

## Phase 2 — Trust label injection tests (Gap 1)

**Goal**: prove that `[OWNER]` / `[GUEST]` is injected into the prompt the LLM
sees, not just that a response arrives.

### Background: how trust labels flow through the stack

Trust labels are injected in `st-plugin/index.js` at ~lines 566–571:
```js
const links = linkState.getLink(character) || {};
const ownerIds = links?.owner_user_ids ?? [];
const isOwner = !!(user_id && ownerIds.includes(user_id));
const trustLabel = isOwner ? '[OWNER]' : '[GUEST]';
const labeledMessage = `${trustLabel}\n${sanitizedMessage}`;
const promptedMessage = actionPrompt ? `${labeledMessage}\n\n${actionPrompt}` : labeledMessage;
```

`promptedMessage` is sent to the extension via WebSocket, which calls
`Generate('quiet', { quiet_prompt: promptedMessage })`. ST builds the full Ollama
request and includes this text in the `messages` array or `prompt` field.
`[OWNER]`/`[GUEST]` will therefore appear in the raw body that fake-ollama
receives.

The fallback path (~line 608) also always injects `[GUEST]` (never bare):
```js
const guestMessage = `[GUEST]\n${sanitizedMessage}`;
```

Heartbeat path uses `[HEARTBEAT]` (not `[OWNER]`/`[GUEST]`).

### New describe block in `full-e2e.test.js`

```js
describe('trust label injection (#191)', () => {
  const TRUST_OWNER = 'qa:trust-owner-191';

  beforeEach(async () => {
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [TRUST_OWNER] }),
    });
  });

  test('[OWNER] is prepended to message in LLM-received prompt for owner user_id', async () => {
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'Trust label owner test',
        channel: 'qa-channel',
        user_id: TRUST_OWNER,
      }),
    });
    expect(r.status).toBe(200);

    const prompt = await fetch(`${FAKE_OLLAMA_URL}/last-prompt`);
    expect(prompt.status).toBe(200);
    expect(prompt.body.raw).toMatch(/\[OWNER\]/);
    expect(prompt.body.raw).not.toMatch(/\[GUEST\]/);
  }, 60000);

  test('[GUEST] is prepended to message in LLM-received prompt for non-owner user_id', async () => {
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'Trust label guest test',
        channel: 'qa-channel',
        user_id: 'qa:trust-guest-191',
      }),
    });
    expect(r.status).toBe(200);

    const prompt = await fetch(`${FAKE_OLLAMA_URL}/last-prompt`);
    expect(prompt.status).toBe(200);
    expect(prompt.body.raw).toMatch(/\[GUEST\]/);
    expect(prompt.body.raw).not.toMatch(/\[OWNER\]/);
  }, 60000);

  afterEach(async () => {
    // Restore clean link state so subsequent describe blocks don't inherit
    // owner_user_ids: [TRUST_OWNER] and get unexpected [OWNER] labels.
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [] }),
    });
  });
});
```

### Implementation notes

**Regex against raw JSON string**: `toMatch(/\[OWNER\]/)` runs against the
unparsed JSON body string. Square brackets are not JSON-escaped, so `[OWNER]`
appears literally in the string regardless of whether ST sent to fake-ollama via
`/api/generate` (prompt field) or `/api/chat` (messages array). No need to parse
`r.body.raw` as JSON in the test — the string match covers both Ollama API formats.

**If `/last-prompt` returns 404**: it means the generate call never reached
fake-ollama (extension not connected, or generate returned an error before
dispatching). The `expect(r.status).toBe(200)` check before the prompt fetch
will catch this case first and give a clearer failure message.

**Placement**: append this describe block at the end of the file (after the
existing `cold-start with no character-links.json` describe block), consistent
with how all other describe blocks are ordered.

**Gate**: both tests pass, confirming trust labels reach the LLM. Run unit tests
(`npm test`) to confirm no regressions before moving to Phase 3.

---

## Phase 3 — Bearer token validation tests (Gap 2, #96 overlap)

**Goal**: confirm that missing or wrong Bearer token returns 401. Also document
that the CSRF bypass described in #96 is NOT present in current code (a
CSRF-only request also returns 401, not 200). This partially addresses #96.

### Background: what the current auth code does (confirmed by reading source)

`requireBearerToken` in `st-plugin/index.js` (lines 95–112) — **no CSRF bypass
in current code**. It only checks `Authorization: Bearer <token>`. Issue #96
described a bypass branch (`if (csrfToken) { next(); return; }`) that is NOT
present. Our tests confirm its absence.

CSRF middleware ordering: ST's CSRF middleware fires at the Express app level
BEFORE the plugin's `requireBearerToken` middleware. For POST requests this means:

| CSRF valid? | Bearer valid? | Result |
|---|---|---|
| No | No | 403 (CSRF fires first) |
| No | Yes | 403 (CSRF fires first) |
| Yes | No | 401 (passes CSRF, fails Bearer) |
| Yes | Wrong | 401 (passes CSRF, fails Bearer) |
| Yes | Yes | 200 |

For GET requests: CSRF is not enforced on read-only methods. GET with just Bearer → 200.

### New describe block in `full-e2e.test.js`

```js
describe('bearer token validation (#191, #96)', () => {
  test('missing Authorization header returns 401', async () => {
    const r = await fetch(`${ST_URL}/api/plugins/openclaw-bridge/status`, {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
    });
    expect(r.status).toBe(401);
  });

  test('wrong bearer token returns 401', async () => {
    const r = await fetch(`${ST_URL}/api/plugins/openclaw-bridge/status`, {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer definitely-wrong-token',
      },
    });
    expect(r.status).toBe(401);
  });

  test('x-csrf-token header alone does not bypass Bearer auth (#96)', async () => {
    // Confirms the bypass described in #96 is NOT present in current code.
    // Valid CSRF token + session cookie but no Bearer → should be 401, not 200.
    const r = await fetch(`${ST_URL}/api/plugins/openclaw-bridge/characters/TestBot/link`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': stCsrfToken,
        Cookie: stCsrfCookie,
        // Intentionally no Authorization header
      },
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [] }),
    });
    expect(r.status).toBe(401);
  });

  test('x-csrf-token + invalid Bearer still returns 401 (#96)', async () => {
    const r = await fetch(`${ST_URL}/api/plugins/openclaw-bridge/characters/TestBot/link`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': stCsrfToken,
        Cookie: stCsrfCookie,
        Authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [] }),
    });
    expect(r.status).toBe(401);
  });
});
```

### Implementation notes

**Placement**: insert immediately after the Phase 2 (`trust label injection`)
describe block, before `cold-start with no character-links.json` — consistent
with where Phase 2 actually landed in the file.

**No afterEach needed**: every test in this block makes a request that is
rejected before any state is mutated (401 is returned before the route handler
runs). No link state or other server state is modified.

**URL format**: use the full absolute URL `${ST_URL}/api/plugins/openclaw-bridge/...`
with the raw `fetch()` helper. Do NOT use `stFetch()` — it adds auth headers
automatically and would defeat the purpose of these tests.

**stCsrfToken / stCsrfCookie availability**: these module-level `let` vars are
set by `fetchStCsrfState()` in `beforeAll` and are available throughout the
entire test run. They are strings (not null), so they can be passed directly
into request headers.

**Why the CSRF bypass tests return 401 (not 403)**: sending a valid
`x-csrf-token` + valid `Cookie` but no `Authorization` header means the CSRF
middleware passes (it sees a valid token+session pair) and control reaches
`requireBearerToken`, which then returns 401. The 401 (not 200, not 403) is the
specific signal that proves the bypass branch is absent — if the bypass were
present, it would have returned 200.

**Gate**: all four tests pass. Run `npm test` before Phase 4.

---

## Phase 4 — CSRF enforcement tests (Gap 4)

**Goal**: confirm that POST requests without a valid CSRF token are rejected at
403, even when the Bearer auth is correct.

### Background

ST has `disableCsrfProtection: false` in `docker/full/sillytavern/config.yaml`.
The `stCsrfToken` and `stCsrfCookie` module-level vars in the test file are set
by `fetchStCsrfState()` in `beforeAll`. `stFetch()` always includes them. The
raw `fetch()` helper does NOT include them — use `fetch()` for these tests.

### New describe block in `full-e2e.test.js`

```js
describe('CSRF enforcement (#191)', () => {
  test('POST without CSRF headers is rejected with 403', async () => {
    // Valid Bearer, but no x-csrf-token and no session cookie.
    // ST's CSRF middleware fires before Bearer auth and returns 403.
    const r = await fetch(`${ST_URL}/api/plugins/openclaw-bridge/characters/TestBot/link`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
      },
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [] }),
    });
    expect(r.status).toBe(403);
  });

  test('POST with wrong x-csrf-token value is rejected with 403', async () => {
    // Valid Bearer + valid session cookie, but wrong token value → still 403.
    const r = await fetch(`${ST_URL}/api/plugins/openclaw-bridge/characters/TestBot/link`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
        'x-csrf-token': 'definitely-wrong-csrf-value',
        Cookie: stCsrfCookie,
      },
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [] }),
    });
    expect(r.status).toBe(403);
  });

  test('GET requests do not require CSRF token', async () => {
    // Control: CSRF is not enforced on read-only methods.
    const r = await fetch(`${ST_URL}/api/plugins/openclaw-bridge/status`, {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
      },
    });
    expect(r.status).toBe(200);
  });
});
```

### Implementation notes

**Placement**: insert immediately after the Phase 3 (`bearer token validation`)
describe block, continuing the sequence before `cold-start with no
character-links.json`.

**No afterEach needed**: all three tests make requests that are rejected at 403
before the route handler runs — no link state or other server state is modified.

**Why the "wrong x-csrf-token" test sends the valid cookie**: including
`Cookie: stCsrfCookie` along with the wrong token header specifically exercises
the token-validation logic (session recognised, token mismatched → 403). Without
the cookie, the 403 could come from a missing session rather than a bad token
value — a subtly different code path.

**URL format**: use raw `fetch()` with the full `${ST_URL}/api/plugins/openclaw-bridge/...`
URL and an explicit `Authorization: Bearer ${BRIDGE_TOKEN}` header. Do NOT use
`stFetch()` — it adds CSRF headers automatically.

**Gate**: all three tests pass. Run `npm test` before Phase 5.

---

## Phase 5 — Character name case sensitivity test (Gap 5)

**Goal**: confirm that wrong-case character names return a clean error rather
than silently matching a different character or producing garbage output.

### Background

`isSafeCharacterName` at `st-plugin/index.js:135` passes `'testbot'` (it's a
valid non-empty string with no path separators). The name then flows into
`linkState.getLink('testbot')` which finds nothing (links are stored by exact
case). The fallback guest path calls into the extension, which does
`context.characters.findIndex(c => c.name === 'testbot')` — returns -1 since
the character is stored as `'TestBot'` — and sends back a `generate_error`. The
plugin converts this to a 5xx response. The test asserts a 4xx/5xx with a
string `error` field.

### New describe block in `full-e2e.test.js`

```js
describe('character name case sensitivity (#191)', () => {
  test('"testbot" (wrong case) returns clean error rather than matching "TestBot"', async () => {
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'testbot',
        message: 'case sensitivity test',
        channel: 'qa-channel',
        user_id: 'qa:user',
      }),
    });
    expect([400, 404, 500, 503]).toContain(r.status);
    expect(typeof r.body.error).toBe('string');
  }, 30000);

  test('"TestBot" (correct case) succeeds', async () => {
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [] }),
    });
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'case sensitivity correct case test',
        channel: 'qa-channel',
        user_id: 'qa:user',
      }),
    });
    expect(r.status).toBe(200);
    expect(r.body.response).toBeTruthy();
  }, 60000);
});
```

### Implementation notes

**Placement**: insert immediately after the Phase 4 (`CSRF enforcement`)
describe block, continuing the sequence before `cold-start with no
character-links.json`.

**No afterEach needed**: the wrong-case test is rejected before any state
changes (quick error from the extension's `findIndex` returning -1, no LLM
call). The correct-case test calls `stFetch('/characters/TestBot/link', ...)` to
re-link TestBot with `owner_user_ids: []` — this is already clean state, nothing
to restore.

**30s timeout for the error case is intentional**: the wrong-case path still
goes through the full WS round-trip to the extension before returning the error.
It's fast (no LLM call), but 30s leaves room for slow Docker startup conditions.

**`r.body.error` type check**: the test's `fetch()` helper auto-parses JSON
responses. The plugin always returns `{ error: string }` for failures, so
`r.body.error` will be a string. If the response were non-JSON (unexpected), the
helper returns the raw string as `r.body`, and `typeof r.body.error` would be
`'undefined'` — a clear failure signal rather than a false pass.

**Gate**: both tests pass. Run `npm test` before Phase 6.

---

## Phase 6 — WS authentication fix + tests (Gap 3, #171)

This phase requires code changes across five files plus a bundle rebuild. It
is deliberately last because it touches the most infrastructure.

### 6a — `st-plugin/ws-server.js`

**Change 1 — bind address** (line 37):
```js
// BEFORE:
const server = new WS.Server({ port, host: '0.0.0.0' });

// AFTER:
const wsHost = process.env.OPENCLAW_BRIDGE_WS_HOST || '127.0.0.1';
const server = new WS.Server({ port, host: wsHost });
```
Also update the two `console.info` log lines immediately below (lines 38–39 in
the current source) to print `wsHost` instead of the hardcoded `'0.0.0.0'`
and `'localhost'` strings.

**Change 2 — headless token check** (~line 51, inside the `message` handler,
inside the `if (parsed?.type === 'register')` branch, BEFORE the
`sessionManager.registerClient(...)` call):
```js
if (parsed.clientType === 'headless') {
    const expectedToken = typeof getAuthToken === 'function' ? getAuthToken() : '';
    if (expectedToken && parsed.token !== expectedToken) {
        console.warn('[openclaw-bridge] WS headless register rejected: missing or invalid token from', remote);
        try { socket.close(4401, 'Unauthorized'); } catch (e) {}
        return;
    }
}
// existing: sessionManager.registerClient(socket, { ... })
```

`getAuthToken` is already passed into `startWebSocketServer` as a parameter and
is available in the closure. No new imports needed.

**close code 4401**: the `ws` library supports application-defined close codes
in the 4000–4999 range. `socket.close(4401, 'Unauthorized')` sends code 4401 to
the client. In Node 22's built-in `WebSocket`, the close event exposes this as
`e.code`. If a test sees `e.code === 1006` (abnormal closure) instead of 4401,
it means the TCP connection dropped before the close frame arrived — check that
the `socket.close()` call in the server isn't being silently swallowed by the
`try/catch`.

### 6b — `st-plugin/headless-service.js`

**Change 1 — accept bridgeToken option**: in the `start(options)` destructuring
at ~line 120, add `bridgeToken = ''`:
```js
const {
    stUrl = 'http://127.0.0.1:8000',
    timeoutMs = 30000,
    onError = null,
    bridgeToken = '',         // ADD THIS
} = options;
```

**Change 2 — inject token via addInitScript**: immediately after the existing
`addInitScript` call at line 152 that sets `OPENCLAW_BRIDGE_CLIENT_TYPE`:
```js
// Existing:
await STATE.page.addInitScript(() => {
    globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE = 'headless';
});

// ADD IMMEDIATELY AFTER:
if (bridgeToken) {
    await STATE.page.addInitScript((token) => {
        globalThis.OPENCLAW_BRIDGE_BRIDGE_TOKEN = token;
    }, bridgeToken);
}
```

**Playwright `addInitScript(fn, arg)` note**: Playwright serializes `arg` and
passes it to `fn` as its first parameter. The function body runs in an isolated
page context, so it cannot close over Node.js variables — the argument must be
explicitly passed this way, not via a closure. Strings are serializable, so this
works correctly. Do NOT write `addInitScript(() => { globalThis.OPENCLAW_BRIDGE_BRIDGE_TOKEN = bridgeToken; })`
(closure capture) — `bridgeToken` would be `undefined` inside the page context.

**Graceful degradation**: if `bridgeToken` is empty (unconfigured dev setup),
`if (bridgeToken)` skips the injection. The WS server's check is
`if (expectedToken && ...)` — if `expectedToken` is also empty, the check is
skipped entirely and the headless client registers without auth. No breakage in
dev setups without a token configured.

### 6c — `st-plugin/index.js`

Find the `headlessService.start(...)` call inside `init()` and add `bridgeToken`.
Search for `headlessService.start(` in `st-plugin/index.js` — there is exactly
one call site. Add `bridgeToken: getAuthToken()` to its options object:
```js
headlessService.start({
    stUrl: ...,
    timeoutMs: ...,
    onError: ...,
    bridgeToken: getAuthToken(),   // ADD THIS
});
```

### 6d — `st-extension/src/index.js`

In the `open` handler (~line 1467–1468), change the register send:
```js
// BEFORE:
const clientType = globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE || 'ui';
try { ws.send(JSON.stringify({ type: 'register', clientType })); } catch (e) {}

// AFTER:
const clientType = globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE || 'ui';
const regToken = globalThis.OPENCLAW_BRIDGE_BRIDGE_TOKEN || STATE.bridgeToken || undefined;
try { ws.send(JSON.stringify({ type: 'register', clientType, token: regToken })); } catch (e) {}
```

On first headless connect: `OPENCLAW_BRIDGE_BRIDGE_TOKEN` is set by addInitScript
before the page loads → `regToken` is the real token.
On first UI connect: neither global is set, `STATE.bridgeToken` is null →
`regToken` is undefined → token field absent → server skips check for `clientType: 'ui'`.
On UI reconnect: `STATE.bridgeToken` is set from the previous welcome → `regToken`
has the token → server ignores it for UI anyway.

**After editing `src/index.js`, rebuild the bundle:**
```bash
npm run build:extension
```
Commit both `st-extension/src/index.js` and `st-extension/index.js`.

### 6e — `docker/full/docker-compose.full.yml`

In the `sillytavern-full` service's `environment` block (where
`OPENCLAW_BRIDGE_WS_PORT=8765` is already listed), add:
```yaml
- OPENCLAW_BRIDGE_WS_HOST=0.0.0.0
```
This allows the test-runner container to reach port 8765 inside the ST container
(cross-container connections don't go through loopback).

### 6f — Update existing test

In `full-e2e.test.js`, in the `multiple headless clients` describe block, the
raw WS connection sends a register without a token. Update it:
```js
// BEFORE:
ws2.send(JSON.stringify({ type: 'register', clientType: 'headless' }));

// AFTER:
ws2.send(JSON.stringify({ type: 'register', clientType: 'headless', token: BRIDGE_TOKEN }));
```

### 6g — Promote ST_WS_URL to top-level constant

Add to the top-level constants block (with the other `const` declarations):
```js
const ST_WS_URL = process.env.ST_WS_URL || 'ws://sillytavern-full:8765';
```
Remove the inline `const ST_WS_URL = ...` definition from inside the
`multiple headless clients` describe block. **This removal is mandatory** —
leaving both declarations causes a `Cannot redeclare block-scoped variable`
error at the top-level const because the inline one is in the same module scope.

### 6h — New describe block in `full-e2e.test.js`

All WS tests: use a 10000ms internal Promise timeout and 15000ms Jest timeout.
Pattern: resolve on the expected event, reject on error or the internal timer.

```js
describe('WS authentication (#191, #171)', () => {
  test('headless register without token is rejected with close code 4401', async () => {
    const before = await stFetch('/health');
    const countBefore = before.body.clients?.headless ?? 0;

    let closeCode = null;
    const ws = new WebSocket(ST_WS_URL);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for close')), 10000);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'register', clientType: 'headless' })); // no token
      });
      ws.addEventListener('close', (e) => {
        clearTimeout(timer);
        closeCode = e.code;
        resolve();
      });
      ws.addEventListener('error', () => { /* let close handle it */ });
    });

    expect(closeCode).toBe(4401);

    const after = await stFetch('/health');
    expect(after.body.clients?.headless ?? 0).toBe(countBefore);
  }, 15000);

  test('headless register with wrong token is rejected with close code 4401', async () => {
    let closeCode = null;
    const ws = new WebSocket(ST_WS_URL);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 10000);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'register', clientType: 'headless', token: 'wrong-token' }));
      });
      ws.addEventListener('close', (e) => { clearTimeout(timer); closeCode = e.code; resolve(); });
      ws.addEventListener('error', () => {});
    });
    expect(closeCode).toBe(4401);
  }, 15000);

  test('headless register with valid token is accepted and receives welcome', async () => {
    let welcomed = false;
    const ws = new WebSocket(ST_WS_URL);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for welcome')), 10000);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'register', clientType: 'headless', token: BRIDGE_TOKEN }));
      });
      ws.addEventListener('message', (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'welcome') { clearTimeout(timer); welcomed = true; ws.close(); resolve(); }
        } catch {}
      });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
    });
    expect(welcomed).toBe(true);
  }, 15000);

  test('UI register without token is accepted (UI clients are exempt)', async () => {
    let welcomed = false;
    const ws = new WebSocket(ST_WS_URL);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 10000);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'register', clientType: 'ui' })); // no token — UI exempt
      });
      ws.addEventListener('message', (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'welcome') { clearTimeout(timer); welcomed = true; ws.close(); resolve(); }
        } catch {}
      });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
    });
    expect(welcomed).toBe(true);
  }, 15000);
});
```

### Implementation notes for Phase 6

**Order of sub-steps matters**: do 6a → 6b → 6c → 6d (rebuild) → 6e → 6f+6g →
6h. The extension rebuild (6d) must happen before adding the WS auth tests (6h)
that verify the headless client actually connects — the tests would fail if the
extension bundle still sends a register without a token.

**Verifying headless still connects after 6d**: before writing the 6h tests,
check `stFetch('/health').body.clients.headless > 0` from within the test
environment. If it's 0, the token injection failed — debug `addInitScript`
before proceeding.

**The "valid token accepted" test registers an extra headless client**: after
`ws.close()`, the session-manager's unregister is asynchronous. Do NOT check the
client count immediately after `ws.close()` — use `waitFor` (like the existing
`multiple headless clients` test does) to wait for the count to drop back to
baseline before asserting.

**Placement of the 6h describe block**: append at the very end of the file,
after `cold-start with no character-links.json`. Phases 2–5 inserted before
`cold-start`; Phase 6 goes after it to avoid continually inserting in the middle
of the file.

**Gate for Phase 6**: all four new WS auth tests pass. The existing
`multiple headless clients` test still passes (now sends token). The headless
service connects and registers successfully (token injected via addInitScript).

---

## Phase 7 — Full test run + PR

- Run in background (suite takes 15–30 min):
  `npm run test:all 2>&1 | tee /tmp/test-191.txt`
- Check at most once every 5 minutes or on background task notification —
  do NOT poll every few seconds (per CLAUDE.md testing feedback)
- Confirm zero failures across all four tiers: unit + fast + browser + full
- If disk space is low before the run: `docker system prune -f --volumes && docker builder prune -f`
- Present a summary of what changed and why, and wait for the maintainer's
  explicit go-ahead before creating any commit (per CLAUDE.md commit workflow)
- PR title suggestion: `test: full-tier E2E trust & security coverage; fix WS auth (#191, #171)`
- PR closes: #191, #171
- PR partially addresses: #96 (documents that no CSRF bypass is in current code;
  bearer tests in Phase 3 provide the coverage #96 requested)
- Do NOT commit or push without the maintainer's explicit go-ahead (per CLAUDE.md)

---

## Risk log

| Risk | Mitigation |
|------|-----------|
| Extension rebuild breaks headless path | headless-reconnect test catches regressions |
| 127.0.0.1 bind breaks Docker test runner cross-container WS | compose sets OPENCLAW_BRIDGE_WS_HOST=0.0.0.0 |
| getAuthToken not available in headless-service scope | pass as bridgeToken option from index.js |
| CSRF test returns 401 instead of 403 (if middleware order differs) | accept [401, 403] in the expect if it turns out the order is different |
| WebSocket close code 4401 not delivered in Node 22 built-in WebSocket | test with the close event's `code` property; if it comes back 1006 (abnormal), switch to checking `reason` string |
| Phase 6 breaks the headless WS registration (token injection fails) | can verify by checking stFetch('/health').body.clients.headless > 0 after startup |

---

## Session resumption checklist

1. `git checkout feat/issue-191-trust-security-e2e`
2. Read this file (`docs/plan-issue-191.md`)
3. Run `git diff --name-only` to see what is already changed
4. Resume from the first incomplete phase below

### Status

- [x] Phase 0 — Plan written
- [x] Phase 1 — fake-ollama `/last-prompt` endpoint
- [x] Phase 2 — Trust label injection tests (Gap 1)
- [x] Phase 3 — Bearer token validation tests (Gap 2, #96)
- [x] Phase 4 — CSRF enforcement tests (Gap 4)
- [x] Phase 5 — Character name case sensitivity test (Gap 5)
- [ ] Phase 6 — WS authentication fix + tests (Gap 3, #171)
- [ ] Phase 7 — Full test run + PR
