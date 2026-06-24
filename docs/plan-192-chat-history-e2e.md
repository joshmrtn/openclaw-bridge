# Plan: Issue #192 — Full-tier E2E: chat history write correctness

## What we're building

Four coverage gaps to close, plus a new plugin endpoint that makes all the
full-tier history assertions possible:

1. JSONL content correctness (inbound + outbound both written, right text)
2. Correct labels and metadata (ExternalChat, role, timestamp)
3. Heartbeat path history write
4. Concurrent write locking (unit tier)

## New endpoint: GET /history

`readLatestChat` already exists in `chat-history.js` but is never exposed as a
route. All four soft-skips in the E2E suite (`if (historyResp.status === 200)`)
exist because the endpoint didn't exist yet. Adding it unblocks all of them.

**Route:** `GET /history?character=<name>`  
**Auth:** bearer token, via existing `router.use(authMiddleware)` — automatic  
**Returns:** `{ messages: [...] }` where each element is a parsed JSONL object  
**Errors:** 400 if `character` param missing; 400 if `_charDirFor` throws
path-traversal; 500 on other read errors  
**Registration:** add before `log-action`, after existing GET routes —
route order matters for test mocks (GET routes don't affect the POST /generate
mock capture, but keep it consistent)

## Test character strategy

| Gap | Character | Why |
|-----|-----------|-----|
| Gap 1 + 2 (content, labels) | `test_char_2` | No ECHO_CHARACTER_MARKERS prefix; no prior test accumulation; not used by any existing test |
| Gap 3 (heartbeat) | `test_char_1` | Already used in the test_char_1 heartbeat test; extend that test rather than add a new one |
| Gap 4 (concurrent, unit) | temp dir fixture | Pure unit test, no ST involved |

## Sticky scenario usage

`POST ${FAKE_OLLAMA_URL}/scenario` sets a response string that persists until
`/reset` (called in beforeEach). For content assertion tests:

```js
await post(`${FAKE_OLLAMA_URL}/scenario`, { response: 'history-sentinel-unique' });
// → POST stFetch('/generate', { character: 'test_char_2', ... })
// → GET stFetch('/history?character=test_char_2')
// → assert assistant entry content includes 'history-sentinel-unique'
```

test_char_2 is not in ECHO_CHARACTER_MARKERS so the sentinel is returned
verbatim (no `[persona:test_char_2]` prefix). 

## Phases

### Phase 1 — Add GET /history endpoint

**Files:** `st-plugin/index.js`

Red test: harden the existing soft-skip at line ~281 ("response is written to
ST chat history") — it currently passes silently because the skip means no
assertion runs. Changing it to a hard `expect(historyResp.status).toBe(200)`
will fail until the endpoint exists. Run the full-tier suite to confirm red.

Green: add the route.

```js
router.get('/history', async (request, response) => {
    const character = request.query.character;
    if (!character) return response.status(400).json({ error: 'character param required' });
    try {
        const messages = await chatHistory.readLatestChat(character);
        response.json({ messages });
    } catch (err) {
        if (err.message && err.message.includes('path traversal')) {
            return response.status(400).json({ error: err.message });
        }
        response.status(500).json({ error: err.message });
    }
});
```

Gate: unit tests green, full-tier E2E green (the hardened line-281 test passes).

### Phase 2 — Concurrent write locking (unit)

**Files:** `st-plugin/tests/chat-history.test.js`

Red: add a test that calls `appendExternalChatToHistory` twice concurrently
(via `Promise.all`) for the same character, using different exchange IDs and
message content. Assert: the file contains exactly 5 lines (1 header + 2 user
entries + 2 assistant entries), every line parses as valid JSON, and both
sentinels appear.

Green: already green (locking is implemented). Confirm it passes, then gate.

### Phase 3 — Full-tier E2E: content + labels (gaps 1 + 2)

**Files:** `docker/full/test-runner/full-e2e.test.js`

The full pipeline: qa-bus inbound → OC → mock-llm → generate_response on ST
→ fake-ollama → response written to JSONL → OC posts outbound to qa-bus.
Character is TestBot throughout (mock-llm is wired to CHARACTER_NAME=TestBot).

The existing "response is written to ST chat history" test (around line 264)
sends a message and only checks `msgs.length > 0`. Replace it with real
content and label assertions:

- Set fake-ollama sticky scenario to a timestamp-unique sentinel string
  (e.g. `history-sentinel-${Date.now()}`) so we can find the right assistant
  entry amid all the TestBot history accumulated by preceding tests
- Send inbound to qa-bus with a matching unique message text
- Wait for outbound on qa-bus (same waitFor pattern as existing test)
- GET `/history?character=TestBot` — hard `expect(historyResp.status).toBe(200)`
- Find the user entry whose content includes the unique message text
- Find the assistant entry whose content includes the unique sentinel
- Assert on each:
  - user entry: `role === 'user'`, `name === 'ExternalChat'` (mock-llm calls
    `/generate` without user_name, so ExternalChat is the expected fallback),
    `send_date` is truthy
  - assistant entry: `role === 'assistant'`, `send_date` is truthy
- Both `find()` calls must return a defined result (Jest will report clearly
  if either is undefined)

Add a second focused test: "history entries carry user_name when provided"
— call `/generate` directly from the test runner as OC would (POST with
`user_name: 'HistoryTester'`), then read history and assert the user entry
`name` field includes 'HistoryTester'. This path is the plugin handler, not
the OC-agent path, so direct call is appropriate: it IS the full system for
that code path (OC calls `/generate` directly via HTTP — the test is doing
exactly what OC does).

Gate: full-tier suite green.

### Phase 4 — Full-tier E2E: heartbeat path history write (gap 3)

**Files:** `docker/full/test-runner/full-e2e.test.js`

Extend the existing "heartbeat fires correctly for a secondary character
(test_char_1)" test. After the `waitFor` confirms the outbound arrives:

```js
// Verify history was written on the heartbeat path
const histResp = await stFetch('/history?character=test_char_1');
expect(histResp.status).toBe(200);
const msgs = histResp.body.messages || [];
const assistantEntry = msgs.find(m => m.role === 'assistant' && m.content?.includes(SENTINEL));
expect(assistantEntry).toBeDefined();
expect(assistantEntry.send_date).toBeTruthy();
// Heartbeat path does not write a user-side entry (no inbound message)
// — only an assistant entry is expected. Do not assert on user entries here.
```

Note: the heartbeat path in `index.js` only writes the assistant (generated
response) entry to history, not a user-side inbound entry. Verify this is
actually the case before writing the assertion (read the heartbeat branch of
`index.js`). Adjust the assertion if both entries are written.

Gate: full-tier suite green.

### Phase 5 — Harden remaining soft-skips

**Files:** `docker/full/test-runner/full-e2e.test.js`

Four call sites with the soft-skip pattern — harden all of them:

| Line | Test | What to assert |
|------|------|----------------|
| ~1139 | R5 owner action: log-action entry in history | `actionLog` is defined (already asserted inside the if-block, just remove the guard) |
| ~1167 | R5 guest action: no log-action entry | `actionLog` is undefined (same) |
| ~1545 | send_message failed: error logged to history | `errorEntry` is defined (same) |

For each: remove the `if (historyResp.status === 200)` wrapper; let the
inner assertions run unconditionally.

Gate: full-tier suite green.

## Open questions resolved

- **No `/history` route before this PR**: confirmed — `readLatestChat` is
  unused in any route.
- **Auth**: covered automatically by existing `router.use(authMiddleware)`.
- **Path traversal on read side**: `readLatestChat` → `_charDirFor` throws;
  we catch and return 400. The existing unit test at line ~265 covers the write
  side; we don't need a new unit test for the read side (same function).
- **baseDir in Docker**: `DEFAULT_CHATS_DIR` resolves correctly in container
  because `process.cwd()` is the repo root and `sillytavern/data/...` exists.
  The endpoint uses the same default, so reads and writes agree.
- **test_char_2 in ST**: it's a real PNG card baked into the ST Docker image;
  no manual setup needed.
- **Heartbeat user entry**: confirm from code whether heartbeat writes one or
  two JSONL entries before asserting in Phase 4.
