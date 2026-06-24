# Handoff — P7 full-tier file split (+ qa-bus cursor-race fix)

Date: 2026-06-23. Branch: `perf/full-tier-de-sleep` is MERGED (P6, #214). **This work (P7) is
UNCOMMITTED on disk on `main`** (or a fresh branch — see "Branch" below). Nothing pushed yet.

## Goal

Split the 2900-line `docker/full/test-runner/full-e2e.test.js` into thematic files for
maintainability. **Serial only** (`--runInBand`) — parallelism explicitly deferred (the single
headless generation lock caps its payoff; see the merged plan doc `docs/plan-full-tier-overhaul.md`,
"P7 (NEW)" / the parallelism analysis).

## What is DONE (on disk, uncommitted)

Under `docker/full/test-runner/`:
- **`helpers.js`** (NEW) — all shared constants + helpers (`fetch`, `stFetch`, `post`, `sleep`,
  `waitFor`, `waitForQuiescence`, the 3 headless helpers `ensureHeadlessRunning`/`killChromium`/
  `waitForHeadlessReconnect`, `execSync`, CSRF getters `getCsrfToken`/`getCsrfCookie`, `waitForReady`).
- **`test-common.js`** (NEW) — `Object.assign(global, helpers)` so test bodies use bare identifiers
  verbatim; registers per-file `beforeAll` (CSRF fetch) + `beforeEach` (qa-bus + fake-openai reset).
- **`globalSetup.js`** (NEW) — one-time readiness wait (ST/headless/OC + the `sleep(3000)`), so the
  expensive readiness does NOT run per file. Wired via package.json `jest.globalSetup`.
- **`sequencer.js`** (NEW) — alphabetical test-file sequencer for deterministic order (numeric file
  prefixes encode original source order). Wired via `jest.testSequencer`.
- **8 split files** (NEW), all `require('./test-common')` + verbatim describe blocks:
  `01-health`, `02-messaging` (incl. chat-file integrity LAST in this file — see gotcha), `03-heartbeat`,
  `04-websocket`, `05-actions-memory`, `06-install-lifecycle`, `07-resilience`, `08-security`.
  All 31 describes accounted for; extracted byte-exact by a script.
- **`package.json`** — test script `jest … --runInBand`; `jest` config: `testMatch:["**/*.e2e.test.js"]`,
  `globalSetup`, `testSequencer`.
- **`Dockerfile`** — `COPY docker/full/test-runner/*.js .` (was the single file).
- **`full-e2e.test.js`** — DELETED (`git rm`).

Elsewhere:
- **`st-plugin/tests/full-tier-invariant.test.js`** — guardrail now scans ALL `*.e2e.test.js` in the
  test-runner dir (was the single file). Passes 5/5; all FULL-PATH-EXCEPTION annotations survived the
  split.
- **`docker/full/qa-bus/server.js`** — **THE KEY FIX**: `resetState()` no longer zeroes `cursor`
  (kept monotonic). See root-cause below.

## Root cause found + fixed: the "multiple sequential messages" ~50% cold flake

The split surfaced a pre-existing race (masked by the single file's stable ordering):
- qa-bus uses a monotonic `cursor`; OC's qa-channel long-polls `/v1/poll` with its last-seen cursor
  and only gets events with `cursor > fromCursor`.
- `beforeEach` resets qa-bus. The OLD `resetState()` set `cursor = 0`. OC's poll cursor was stale-high
  (e.g. 50) from prior tests. Freshly-injected events got cursor 1, 2 — BELOW 50 — so OC never saw
  them until the counter climbed back up. Whether OC's 250ms poll landed between reset and inject
  (resyncing to 0) or after (missing them) was the ~50% race.
- **Fix:** keep `cursor` monotonic across reset (clear events/messages, don't zero the cursor). Now
  post-reset events always sort above OC's cursor → always delivered. Zero added latency.
- **Validation:** a direct stress loop (reset → inject 2 → expect 2 outbound, ×12) — see
  `scratchpad/stress.js` logic — passes 12/12 post-fix (was ~50% before). No test depends on the
  cursor value (verified).

## Validation status

- Infra sound: across MANY runs, 6–7 of 8 files pass rock-solid.
- Clean cold `test:e2e:full` passed **85/85 (295s)** once (before the cursor fix was even needed — that
  run happened not to hit the race). The split is speed-neutral (295s vs pre-split 304s).
- The cursor fix eliminates the "multiple sequential" flake — stress loop **12/12 PASS confirmed**
  (`scratchpad/stress.js`; was ~50% before the fix).
- **IN PROGRESS: a clean cold `npm run test:all` gate is RUNNING with the cursor fix in place**
  (started end of session; output → `/tmp/test-all.log`). NEXT SESSION: read `/tmp/test-all.log`
  (`tail -60`). If it shows "All four tiers passed" (Unit 310 · Fast 27 · Browser 9 · Full 85),
  proceed to commit + PR. If the log is stale/incomplete (background task didn't survive the session
  boundary), just re-run `npm run test:all`.

## How to land (next session)

1. `npm run test:all` (it does a full clean down+build+up; ~25 min; auto-logs to `/tmp/test-all.log`).
   Confirm all four tiers green: Unit 310 · Fast 27 · Browser 9 · Full 85.
2. If green, present the diff for Josh's pre-commit review, then commit + push + PR. Suggested commits:
   (a) `test: split full-e2e suite into thematic serial files` (the split + infra + guardrail + Dockerfile + package.json),
   (b) `fix(qa-bus): keep cursor monotonic across reset to stop dropped post-reset messages` (the race fix).
   Or one PR, two commits. Josh merges.
3. After merge: nothing else outstanding for P7. The overhaul (P1–P7) is then complete.

## Gotchas / hard-won lessons (don't re-discover)

- **Warm/reused stack lies for generation-heavy & heartbeat tests.** Verify on a FRESH stack only.
  `docker compose restart openclaw` is BROKEN (entrypoint reinstall fails on warm state) — use
  `up -d --force-recreate openclaw` or a full down+up. (Memory: `full_tier_heartbeat_warm_stack`.)
- **Chat-file integrity "object/null name" failure is contamination, not a bug.** TestBot's chat
  JSONL accumulates across runs if the ST data volume persists. The malformed line is
  `name:null, mes:"[send_message failed]: 'content' is required"` written by the R5 send_message test
  (05). The integrity test (in 02, runs before 05 in a clean run) only fails when that line is leftover
  from a prior run. In clean CI (`down --volumes`) it passes. **Keep chat-integrity in 02 (early) — it
  is ORDER-SENSITIVE** (validates the whole accumulated file); moving it LAST (a tried 09 file) made it
  deterministically fail because by then 05's null-name line exists. Reverted; do not move it again.
- The first-ever cold run of freshly-built images flaked on multi-message tests (cold Playwright). The
  cursor fix should remove the "multiple sequential" part; the burst part was contamination.

## Branch note

If this was left on `main` uncommitted, create a branch before committing (branch protection / workflow
requires feature branches). Suggested: `refactor/split-full-e2e-suite`.

---

## Live progress log (appended as work proceeds — newest at bottom)

- Split implemented (8 files + infra), original deleted, guardrail updated. 6–7/8 files solid.
- Root-caused the `multiple sequential` ~50% cold flake → qa-bus `resetState` zeroed the poll cursor.
- Applied fix: keep cursor monotonic across reset (`docker/full/qa-bus/server.js`). No test depends on
  cursor value.
- Validated fix: direct stress loop (reset→inject 2→expect 2) **12/12 PASS** (was ~50% before).
- Launched clean `npm run test:all` gate WITH the fix → logging to `/tmp/test-all.log`. **WAITING** for
  it to finish (~25 min). Next: read result; if green, branch + commit + PR.
- ✅ **GATE GREEN** (clean cold, with cursor fix): all four tiers — Unit 310 · Fast 27 · Browser 9 ·
  Full 85 (all 8 split files PASS, 02-messaging 47s, no flake). The split + cursor fix are validated.
- Next: branch `refactor/split-full-e2e-suite`, commit (split + qa-bus fix), push, open PR for Josh.
- ✅ **DONE** — branch `refactor/split-full-e2e-suite` pushed; 2 commits (`5cbcb64` qa-bus fix,
  `49db06a` the split). **PR #215 opened**: https://github.com/joshmrtn/openclaw-bridge/pull/215.
  Awaiting CI + Josh's review/merge. (docs/ working files remain uncommitted, as intended.)
- After #215 merges: the P1–P7 full-tier overhaul is COMPLETE. No further P7 work outstanding.
