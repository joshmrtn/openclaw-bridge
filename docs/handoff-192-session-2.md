# Handoff: Issue #192 — Full-tier E2E: Chat History Write Correctness
## Session 2 — June 2026

---

## Branch

`feat/issue-192-chat-history-e2e`

## What is done (committed or staged as unstaged changes)

Three files modified (`git diff --stat HEAD` shows 129 +, 33 -):

### 1. `st-plugin/index.js` — New `GET /history` endpoint

Added a bearer-authenticated endpoint (registered before the `log-action` route at ~line 451):

```js
router.get('/history', async (request, response) => {
    const character = request.query.character;
    if (!character) return response.status(400).json({ error: 'character param required' });
    try {
        const messages = await chatHistory.readLatestChat(character);
        return response.json({ messages });
    } catch (err) {
        if (err.message && err.message.includes('path traversal')) {
            return response.status(400).json({ error: err.message });
        }
        return response.status(500).json({ error: err.message });
    }
});
```

Path-traversal rejection is delegated to `readLatestChat`, which already validates the character name.

### 2. `st-plugin/tests/chat-history.test.js` — Concurrent write unit test

Added at the end of the describe block — tests that two simultaneous writes don't corrupt the JSONL file:

```js
test('concurrent writes to the same character are serialized without JSONL corruption', async () => {
    await Promise.all([
        chatHistory.appendExternalChatToHistory('Frog', { message: 'Concurrent message A', images: [], user_id: 'discord:1' }, 'Response A', tmpDir, null, 'exchange-concurrent-a'),
        chatHistory.appendExternalChatToHistory('Frog', { message: 'Concurrent message B', images: [], user_id: 'discord:2' }, 'Response B', tmpDir, null, 'exchange-concurrent-b'),
    ]);
    const msgs = await chatHistory.readLatestChat('Frog', tmpDir);
    expect(msgs.length).toBe(6);
    expect(msgs.every(m => !m.raw)).toBe(true);
    // ... user + assistant entry assertions
```

This uses the `tmpDir` fixture already established in the file.

### 3. `docker/full/test-runner/full-e2e.test.js` — Multiple changes

**Phase 3 — Two new tests (around line 267–333):**
- `inbound and outbound both written to ST chat history with correct content (#192)` — sends QA bus message, waits for outbound, then hits `GET /history?character=TestBot` and verifies both a user entry (containing the sentinel text) and an assistant entry (containing the fake-ollama SENTINEL response) exist with correct fields (`is_user`, `name`, `send_date`).
- `history entry carries user_name when provided (#192)` — calls `/generate` directly with `user_name: 'HistoryTester'`, checks that the history user entry's `name` field contains `HistoryTester`.

**Phase 4 — Heartbeat history assertion (around line 732):**
Inside the `test_char_1` heartbeat test `try` block, after waiting for the heartbeat outbound message, added:
```js
const histResp = await stFetch('/history?character=test_char_1');
expect(histResp.status).toBe(200);
const msgs = histResp.body.messages || [];
const hbEntry = msgs.find(m => m.is_user === false && typeof m.mes === 'string' && m.mes.includes(SENTINEL));
expect(hbEntry).toBeDefined();
expect(hbEntry.send_date).toBeTruthy();
```

**Phase 5 — Hardened 4 previously soft-skipped assertions:**
All previously used `if (historyResp.status === 200)` guards — those are now removed and `expect(historyResp.status).toBe(200)` is used instead. Also fixed a pre-existing bug: all 4 had `m.content` but the field is `m.mes`. All 4 now use `m.mes`.

**R5 owner senderId bug fix (line 1173):**
Was `senderId: 'qa:owner-user'`. OC prefixes senderId with channel type (`'qa:' + senderId`), so this produced `'qa:qa:owner-user'` which didn't match `owner_user_ids: ['qa:owner-user']`. Fixed to `senderId: 'owner-user'`.

**#111 send_message missing content test (line 1562–1603):**
This test is STILL BROKEN. See "What is still broken" below.

---

## What is STILL BROKEN

### The `send_message with missing content` test (#195 / #111)

**Test code:** `docker/full/test-runner/full-e2e.test.js` line 1562–1603

**The test sends:** QA bus message with `senderId: OWNER_SENDER_ID` (`'owner-user'` after the fix above), expects:
1. Direct reply contains `REPLY_TEXT` and no `<action>` block ✓ (this works)
2. No blank channel post sent ✓ (this works)
3. Error entry appears in ST chat history with text matching `send_message failed` and `content` ✗ **FAILS**

**Root cause of failure (fully diagnosed):**

The QA bus → OC → mock-llm path does NOT pass the sender's user_id through to `/generate`. The mock-llm in `docker/full/mock-llm/server.js` has `extractUserId(text)` which looks at the message text:

```js
function extractUserId(text) {
    const match = /(?:GUEST|OWNER\]?\s+)?([\w:.-]+)(?:\s*:)?/i.exec(text);
    return (match && match[1].includes(':')) ? match[1] : 'qa:test-user';
}
```

The message text is `'Post nothing.'`. The regex matches `Post` but `Post` contains no `:`, so it falls back to `'qa:test-user'`.

The mock-llm then calls `/generate` with `user_id: 'qa:test-user'`.

The character link has `owner_user_ids: ['qa:owner-user']`.

`'qa:test-user'` is NOT in `owner_user_ids` → `isOwner = false` → `resolveActions` is NEVER called → error is NEVER logged to history → `expect(errorEntry).toBeDefined()` fails.

**What needs to happen (the CORRECT fix — not the shortcut):**

The full E2E tier must test the REAL system end-to-end. The fix is NOT to bypass OC and call `/generate` directly. Instead, the mock-llm must correctly propagate the sender's identity so that by the time `/generate` is called, the right `user_id` is included.

The OC agent prompt context includes the sender's ID (it's set in `userId = channelType + ':' + senderId` in `oc-plugin/src/index.ts` line 631–632). The mock-llm just doesn't read it correctly.

**Option A — Fix `extractUserId` in mock-llm:**
Make the regex read the OC-formatted sender ID from the message context that OC includes in the agent prompt. Inspect exactly what OC's agent prompt template looks like (i.e. what the `messages` array contains in the mock-llm's `/v1/chat/completions` request body when an inbound message arrives). Once you know the format, fix `extractUserId` to reliably parse it. The user text the mock-llm sees is the full OC agent prompt, NOT just the raw Discord message.

**Option B — Add owner_user_ids to include mock-llm's fallback:**
Add `'qa:test-user'` to the character link's `owner_user_ids` in the test. This is a quick workaround, but might mask the real mismatch.

**Option A is correct** — it fixes the root cause without game-playing with the link configuration.

**To diagnose:** Add a temporary `console.log` in `docker/full/mock-llm/server.js` to print the full messages array received on `/v1/chat/completions`. This will show exactly what text OC puts in the user turn, which will let you update `extractUserId` to correctly extract the real sender ID.

---

## Diagnostic console.log lines still in the code

Two lines need to be removed AFTER the test is fixed:

1. `full-e2e.test.js` line ~1193 (inside R5 owner action log test):
   ```js
   console.log('[diag] R5 action log — last 5 mes values:', messages.slice(-5).map(m => m.mes?.slice(0, 120)));
   ```

2. `full-e2e.test.js` line ~1598 (inside missing-content test):
   ```js
   console.log('[diag] send_message missing content — total messages:', messages.length, '— last 10:', messages.slice(-10).map(m => ({ is_user: m.is_user, mes: m.mes?.slice(0, 120) })));
   ```

---

## Docker image situation — CRITICAL

The `openclaw-bridge:oc-qa` base image was accidentally deleted by running `docker image prune -a -f` mid-session. This image takes ~10 minutes to rebuild and requires ~7–8 GB of free disk space. At session end, disk was at **3.6 GB free** (49 GB total, 45 GB used). The rebuild fails with `no space left on device`.

**Before doing anything else:**

```bash
docker system prune -f --volumes && docker builder prune -f
```

This should recover ~4–8 GB. Then rebuild the oc-qa image:

```bash
bash docker/full/build-oc.sh
```

That script builds `openclaw-bridge:oc-qa`. After it completes, the full test suite can run.

**NEVER run `docker image prune -a -f`** — it deletes ALL images including the oc-qa base that takes 10+ minutes to rebuild.

---

## Key architecture understanding (do NOT re-derive from scratch)

1. **full-tier E2E must go through the full real system.** QA bus → real OC → real ST plugin → real fake-ollama (the LLM is fake but everything else is real). Never bypass OC with a direct `/generate` call in full-tier tests. The user is extremely firm on this.

2. **JSONL field is `mes`, not `content`.**  `constructStMessage()` stores content in `mes`. All history assertions must use `m.mes`.

3. **The mock-llm path is used for all QA bus messages** because the OC agent ID is `'bridge'` but character links use `oc_agent_id: 'default'`. `'default' !== 'bridge'` → `before_dispatch` hook does NOT intercept → mock-llm generates the agent response and calls `/generate`. This is by design.

4. **Trust enforcement:** `isOwner = !!(user_id && ownerIds.includes(user_id))`. If `isOwner = false`, `rawPendingActions = []` and `resolveActions` is never called. For the error-log test to pass, the mock-llm must call `/generate` with the correct `user_id` that matches `owner_user_ids`.

5. **heartbeat path:** heartbeat writes ONE history entry (assistant only, via `appendMessage`). Regular exchange writes TWO (user + assistant, via `appendExternalChatToHistory`).

---

## Plan file

The original plan for this issue is at: `docs/plan-192-chat-history-e2e.md` (if it still exists — check the file).

---

## Next session checklist

1. `docker system prune -f --volumes && docker builder prune -f` — free disk space
2. `bash docker/full/build-oc.sh` — rebuild oc-qa base image
3. Diagnose mock-llm `extractUserId`: temporarily log the full `/v1/chat/completions` request body in mock-llm to see what OC puts in the user turn when a QA bus message arrives — this is the text `extractUserId` is operating on
4. Fix `extractUserId` to correctly parse the OC agent prompt and return the real sender's user_id (e.g. `'qa:owner-user'`)
5. Remove the two `console.log('[diag]')` lines from `full-e2e.test.js`
6. Run `npm run test:all` (background, writes to `/tmp/test-all.log`)
7. Verify all four tiers green
8. Only then proceed to commit
