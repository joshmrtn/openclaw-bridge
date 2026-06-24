# Plan — Full-tier E2E overhaul

Status: **DRAFT for review — do not start implementing until explicitly approved.**
Owner: Josh. Drafted: 2026-06-22.

This is a large, multi-session plan. Each phase is an independently-landable PR gated on
`npm run test:all`.

## Progress (live — 2026-06-23)

- **P1 docker rebuild fix** — ✅ MERGED (PR #209). oc-full now compose-built; force-rmi removed; test:all four tiers green.
- **P2 invariant guardrail + CLAUDE.md** — ✅ PR #210 open (awaiting review). Unit-tier guardrail enforces FULL-PATH-EXCEPTION on direct /generate calls; 29 calls annotated; four tiers green (Unit 310/Fast 27/Browser 9/Full 84).
- **P5 chat-file integrity** — ✅ MERGED (PR #211). Burst of qa-bus messages → raw TestBot JSONL validated (every line parses, schema, exchange_id pairing, each sentinel exactly once). Landed independently of P3, ahead of P4.
- **P3 unified mock** — ✅ IMPLEMENTATION COMPLETE on `feat/unified-fake-ollama`. Decision was
  OpenAI-everywhere (one `fake-openai`). Full tier green (85/85) via the real path. `test:all`
  four-tier gate running before commit/PR. fake-ollama + mock-llm deleted. See P3 progress below.
- **P4 de-shortcut promotions** — ✅ IMPLEMENTATION COMPLETE on `test/192-promote-trust-label-fullpath`
  (off merged main after #212). Both `(temporary)` direct-/generate trust tests
  (`full-e2e.test.js` owner/guest) rewritten to the full qa-bus path: prime unique sentinel →
  inject via qa-bus with owner/guest senderId → poll fake-openai `/last-prompt` for the unique
  message marker → assert the captured request body contains `[OWNER]` (resp. `[GUEST]`). Both
  green on the live stack (1.0s each). **Live-probe finding (the plan's flagged TODO):** OC
  prepends the channel type to senderId (`oc-plugin/src/index.ts:632` `${channelType}:${senderId}`),
  so on qa-channel senderId `trust-owner-191` reaches ST as `qa:trust-owner-191`. owner_user_ids
  must hold the prefixed form — the old `:316` enabler had the same latent mismatch (owner silently
  got [GUEST]) but never asserted the label, so it went unnoticed. ZERO `(temporary)` annotations
  remain; guardrail green (5/5). `user_name (#192)` — no direct test present in the suite (already
  covered elsewhere); nothing to promote. `npm run test:all` four-tier gate running before commit/PR.
- **P6 speed / de-sleep** — blocked on P4 (and touches the same file heavily).
 Phases carry no phase labels into code (issue numbers only — see
global rule on no phase comments). Phase structure lives only in this doc.

## Why this work exists

The full tier (`docker/full/`) is the only place the **whole system** is proven across its
**lifecycle: install → use → uninstall**, with real OC + real ST + real openclaw-bridge.
The only fakes are the LLM and the "discord" channel (qa-bus). Four recurring problems:

1. **Invariant erosion.** After compaction, agents drift toward calling ST `/generate`
   directly, silently demoting full-tier tests to slow dockerized unit tests.
2. **Docker rebuild friction.** `oc-full` is a named `image:` service; `--build`/`--rmi local`
   don't touch it, so `test-all.sh` force-`rmi`s it. Hammer, not screwdriver.
3. **Slow (~20–30 min) + sleep-based flakiness.** Hard `sleep()`s paper over heartbeat races.
4. **Fake LLM underused / accidentally split.** Two fakes (`mock-llm` OpenAI-Responses for OC's
   agent; `fake-ollama` Ollama for ST). Original intent was ONE primeable Ollama mock both use.

The invariant is captured in memory (`full_tier_invariant.md`, `fake_llm_capabilities.md`) and
the `MEMORY.md` index. This plan hardens it in the repo and fixes 1–4.

## Current state (verified 2026-06-22)

- ST container **installs via `setup.sh`** at entrypoint; `verify.sh` asserted (`0 failed`) at
  boot and after reinstall. Real uninstall test (`#40`) asserts our dirs removed AND character
  cards / `config.yaml` / `settings.json` survive. Lifecycle invariant is **partially honored**.
- ~100 tests in a single `full-e2e.test.js` → run **serially** (Jest parallelizes across files only).
- Direct-`/generate` tests split into:
  - **Legitimate** (OC can't drive): auth/CSRF, WS-layer mechanics (auth, reconnect, multi-client,
    reload-headless, liveness), induced-infra-failure resilience, same-instant concurrency/bleed.
  - **Demoted by convenience** (should be full-path): `user_name (#192)`, `trust label injection
    (#191)` (self-labelled "confirmed by unit tests"), `character name case sensitivity`,
    `empty LLM response heartbeat`. **All trace to one root cause: `mock-llm` is rigid** — no
    runtime priming, doesn't forward `senderName`→`user_name`, can't target a non-`TestBot` char.
- **Coverage gap:** no explicit chat-file JSONL-integrity assertion after a multi-message lifecycle.

## Resolved design decisions

- **Mock LLM:** full redesign to one runtime-primeable mock (user's original intent). OC supports
  `api: "ollama"`, so single-protocol consolidation is the target.
- **Scope:** all four problems, drafted as this multi-phase plan (multiple sessions OK).
- **Invariant durability:** CLAUDE.md + a code guardrail (not memory alone).

## Open design decision to resolve in an early spike

- **OC↔Ollama connectivity is proven** — Josh has pointed OC at a real Ollama on the same machine in
  manual testing. So Target A's basic premise holds; the spike narrows to ONE question:
- **Can OC's `api: "ollama"` provider do the tool-calling dance** (turn 1: emit a tool call to
  `generate_response`; turn 2: text) that `mock-llm` currently does via OpenAI Responses? If Ollama
  tool-calling can't drive it cleanly, fall back to the agent emitting an `<action>`/text form, or Target B.
  - **Target A (ideal):** one Ollama mock; OC switched to an `ollama` provider. Requires OC ollama
    tool-calling to work end-to-end.
  - **Target B (fallback):** one server *process* serving both Ollama `/api/*` and OpenAI
    `/v1/responses`, backed by ONE shared scenario store. No bet on OC provider switch; still
    achieves "one solid primeable mock, one priming API."
  - Phase 3a spikes this and picks A or B.

---

## Phases

Dependencies: P3 → P4 (mock unlocks promotions). P1, P2, P5 independent. P6 after P4.

### P1 — Docker rebuild fix (self-contained, high relief)

Goal: kill the force-`rmi` hammer via content-addressed compose builds.

- Give the `openclaw` compose service a `build:` stanza (context `../..`, dockerfile
  `docker/full/openclaw/Dockerfile`, `args: { OC_BASE: openclaw-bridge:oc-qa }`) while keeping
  `image: openclaw-bridge:oc-full`. Compose then builds+tags it; `--build` rebuilds the
  fast-changing `COPY . /repo` layer when `oc-plugin` changes; `--rmi local` removes it.
- Remove `docker rmi -f openclaw-bridge:oc-full` from `test-all.sh` `teardown_full` and the
  separate `run_build "oc-full image"` step; rely on `docker compose --profile full-test build`.
- Keep `oc-qa` as a documented one-time prerequisite; add a clear preflight error in `test-all.sh`
  if `oc-qa` is missing (points to `npm run docker:full:build-oc`).
- Verify (manual, documented): edit a sentinel in `oc-plugin/src`, run `docker compose build`
  (NO manual rmi), confirm the new code runs in the container — the exact bug that caused false-greens.
- On success update `feedback_docker_rebuild.md` memory + CLAUDE.md pre-commit-gate notes.

### P2 — Invariant durability: CLAUDE.md + guardrail (interlocks with P4)

Goal: make the bypass prohibition structurally enforced and compaction-proof.

- CLAUDE.md "Testing Strategy": add the invariant, the bypass prohibition, and the litmus test.
- Guardrail (runs in the always-green **unit** tier so CI enforces it): a test that scans
  `full-e2e.test.js` for direct plugin-endpoint calls (`stFetch('/generate'`, etc.) NOT preceded
  by a `// FULL-PATH-EXCEPTION: <reason>` annotation, and fails listing offenders.
- Red: guardrail fails on today's un-annotated direct calls. Green: annotate the **legitimate**
  ones (this is the audit's annotation half); the **demoted** ones get a temporary annotation
  referencing the P4 promotion issue so the bar stays green until promoted.

### P3 — Unified primeable mock LLM (keystone)

- **3a Spike:** stand up OC against an `ollama` provider pointed at `fake-ollama`; confirm the
  agent calls `generate_response` via Ollama tool-calling. Pick Target A or B. Timebox.
- **3b Build:** unified mock = `fake-ollama` extended with the agent tool-calling role + a shared
  scenario store. Distinguish roles by request shape (has `generate_response` tool / tool output →
  OC agent; plain prompt → ST). Add/keep `/scenario`, `/reset`, sentinels, `/last-prompt`, and add
  field-forwarding so `senderName`→`user_name` and target character flow through. Unit-test the
  mock in isolation (pure Node http).
- **3c Wire:** point OC's provider at the unified mock; retire `mock-llm` service (Target A) or fold
  its `/v1/responses` into the one server (Target B). Update `openclaw.json` + compose.
- **3d Green:** full tier still passes through the real path; update `fake_llm_capabilities.md`.

### P4 — De-shortcut audit + promotions (depends on P3; START HERE next session after #212 merges)

**Branch off MERGED main** (not the P3 branch) to avoid a stacked PR.

**Authoritative TODO = the two `(temporary)` annotations only** — `full-e2e.test.js:2503` & `:2524`
(owner / non-owner trust-label tests that call `/generate` directly and self-describe as "confirmed
by unit tests"). Other FULL-PATH-EXCEPTIONs audited and confirmed LEGITIMATE: same-instant
concurrency (364/389/422), heartbeat-path isolation (556), WS-layer probes (726/789), qa-channel
inbound-only outbound-action tests (1384/1483/1512), write_memory stSideAction (1600/1710),
induced-infra-failure (2133/2228/2257/2284/2353), and the character-hardcode case tests (346/2448/
2468 — the OC agent hardcodes target char via `OC_CHARACTER`, so OC genuinely can't send a
wrong-case/unlinked name). Leave these annotated.

**Proven enabler (verified 2026-06-23):** the qa-bus `senderId` flows through OC to ST `/generate`
as `user_id`, and ST matches it against `owner_user_ids`. The existing FULL-PATH test
`trust label enforcement › owner user gets a response` (`:316`) already links TestBot with
`owner_user_ids: ['qa:owner-user']` and injects `senderId: 'qa:owner-user'` — but only asserts the
response is truthy, NOT that the label reached the prompt. So promotion is mechanical:

Recipe for each (owner, guest):
1. `POST /scenario` a UNIQUE sentinel on fake-openai.
2. Link TestBot with `owner_user_ids: ['qa:owner-user']` (owner case) — guest case uses any other
   senderId.
3. Inject via qa-bus `POST /v1/inbound/message` with the owner / non-owner `senderId`.
4. `waitFor` the sentinel on qa-bus `/v1/state` outbound events.
5. **The real assertion:** `GET /last-prompt` on fake-openai and assert the raw body contains
   `[OWNER]` (resp. `[GUEST]`) prefixing the message — this proves hard label injection through the
   real path, replacing the weak "confirmed by unit tests" direct call.
   (TODO confirm: that the label literally appears in fake-openai's captured request body — quick
   probe with a live `docker:full:up` stack before writing the assertion.)
6. Delete the two direct-`/generate` `(temporary)` tests; the P2 guardrail then has ZERO temporary
   annotations remaining (the green-bar goal).

`user_name (#192)` / `character case sensitivity` / `empty heartbeat` from the original P4 list:
re-audit — case-sensitivity is legitimately direct (see above); user_name/empty-heartbeat may
already be covered full-path or be similar `/last-prompt` assertions. Decide during P4.

### P5 — Chat-file integrity test (guards the worst-fear bug; independent)

- New full-path test: drive N interleaved inbound messages + heartbeats through qa-bus, then read the
  raw chat JSONL from the container and assert: every line parses as JSON; required fields present
  (`name`, `is_user`, `mes`, `send_date`); no torn/partial lines; no unexpected duplicates; order sane.
- Stress variant: rapid/concurrent messages across TestBot + Narrator to exercise the write lock.

### P6 — Speed + de-sleep (DRAFT for review — 2026-06-23; START AFTER approval)

**Scope decision (Josh, 2026-06-23):** de-sleep first for the safe wall-clock win; defer the
file-split-for-parallelism. The 2700-line `full-e2e.test.js` split into thematic files comes AFTER,
as a separate maintainability pass kept **serial** (`--runInBand`) — NOT parallelized. Parallelism
is rejected for now: all tests share one docker stack with global mutable state (fake-openai sticky
scenario + `lastPromptRaw`, qa-bus event log, `character-links.json` on a shared volume), so parallel
workers would race. True parallelism would require per-file isolation (separate characters, scenario
namespacing, separate qa channels) — a bigger project, out of P6 scope.

**Baseline (2026-06-23, `npm run test:all`):** Full tier **~337s**; **58.3s** of that is 12 literal
`sleep()` calls (5×6000, 1×12000, 1×8000, 1×5000, 1×3000, 1×300). Heartbeat loop interval
`OPENCLAW_BRIDGE_HEARTBEAT_LOOP_MS=5000` (full compose).

**Two enablers verified (2026-06-23):**
- **Heartbeat loop is non-reentrant** (`oc-plugin/src/index.ts:740` `runningHeartbeats.has(...)` guard)
  AND the loop interval is only the *polling granularity* — actual firing is gated by per-character
  `hb.interval_ms`. So lowering the loop interval 5000→1000 is SAFE: more frequent checks, never
  stacked generations. This shrinks every "wait N loop ticks" sleep.
- **fake-openai `/pending-count` only counts delay-scenario holds** (`pendingDelayCount`), NOT a
  universal in-flight gauge. So "drain stray pipeline" sleeps cannot become deterministic today
  without adding a real quiescence signal to the mock (see P6.2).

**Honest expectation:** not all 58.3s vanishes. Sleeps fall in three classes:
1. *Tick-bound* ("wait N loop ticks", e.g. the 12000 "no second idle heartbeat"): shrink ~linearly
   with the loop interval → biggest win.
2. *Pipeline-drain* (5×6000 "let stray heartbeat pipeline finish before reset"): floored by the ST
   generation round-trip (~3s), NOT the tick — these only shrink to ~pipeline time unless made
   deterministic via P6.2.
3. *Negative-assertion* ("confirm no blank post arrives", 5000/6000): need a bounded window ≥ one
   round-trip; shrink modestly, stay bounded.
Realistic target: full tier from ~337s toward ~250–270s. Measure and record the real delta.

#### Phases (each its own PR, gated on `npm run test:all`)

- **P6.1 — Lower the heartbeat loop interval.** Set `OPENCLAW_BRIDGE_HEARTBEAT_LOOP_MS=1000` in the
  full compose; retune the tick-bound sleeps (esp. the 12000) and any `waitFor` timeouts that assumed
  5s ticks; re-audit per-character `hb.interval_ms` test values. Gate + measure delta.
- **P6.2 — Deterministic drains.** Add a universal request gauge to `docker/fake-openai/server.js`
  (e.g. a monotonic `requestsSeen` counter + `GET /request-count`). Replace the 5×6000 pipeline-drain
  sleeps with a `waitForQuiescence()` helper (count stable for ~1s ⇒ no in-flight generation), so
  drains resolve as fast as the actual pipeline instead of a fixed 6s. Gate + measure.
- **P6.3 — Shrink negative-assertion windows.** Re-derive the "prove nothing fired" sleeps as small
  multiples of the new interval via a named helper (e.g. `assertNothingFor(ms)`), documenting they
  are intentional bounded negative-windows (not lazy drains). Keep ≥ one round-trip. Gate + measure.
- **P6.4 — Record the delta.** Final before/after wall-clock here; update memory if the heartbeat-loop
  semantics or quiescence helper are reusable knowledge.

**RESULT (2026-06-23, clean `npm run test:all`):** Full tier **337s → 304s (~33s, ~10% faster)**,
all four tiers green (Unit 310 / Fast 27 / Browser 9 / Full 85), no flakiness on the clean run.
Honest note: short of the optimistic 250–270 estimate — the remaining wall-clock is dominated by the
restart/infra-failure tests (plugin-restart ~23s; headless-down / cold-start / HTTP-polling ~19s each)
and per-test generation round-trips, NOT sleeps. Those are the deferred P7 restart-consolidation +
legitimate infra waits, so ~304s is near the de-sleep ceiling without consolidating restarts.
Inner-loop lesson: heartbeat/idle tests are sensitive to OC's in-memory state and `docker compose
restart openclaw` is broken for this stack (entrypoint reinstall fails on warm state), so warm-stack
filtered reruns are unreliable for them — verify these on a fresh stack (full `test:all`).

#### Open questions — RESOLVED (Josh, 2026-06-23)
1. **Loop interval target: 1000ms.** Safe per the non-reentrancy + polling-granularity finding.
2. **P6.2 scope: yes — add the `/request-count` gauge.** Replace the 5×6000 drains with a
   deterministic `waitForQuiescence()`; accept the small amount of extra mock code for robustness.
3. **ST-restart consolidation: folded into P7** (the serial-split pass), where the file structure is
   already changing — not P6.

### P7 (NEW) — Split `full-e2e.test.js` into thematic files, kept serial

Maintainability only, speed-neutral. Done with `--runInBand` + globalSetup + a deterministic
sequencer; 8 files (`01-health` … `08-security`). **IMPLEMENTATION COMPLETE, UNCOMMITTED on disk;
test:all gate running.** Full details + how-to-land + gotchas: **`docs/handoff-p7-file-split.md`**.

Surfaced + fixed a pre-existing qa-bus race (`resetState` zeroed the monotonic poll cursor → OC
dropped post-reset messages ~50% of cold runs in the "multiple sequential" test). Fix: keep cursor
monotonic across reset (`docker/full/qa-bus/server.js`). Validated 12/12 via a direct stress loop.
Parallelism stays deferred (generation-lock ceiling). After P7 lands, the P1–P7 overhaul is COMPLETE.

## P3 DECISION (2026-06-23, after Docker spike): unify on ONE OpenAI mock (`fake-openai`)

Docker spike outcome — Target A (OC speaks Ollama) is BLOCKED, and a better path emerged:

- **Architecture confirmed:** the OC bridge plugin's `before_dispatch` intercepts whenever a
  character is linked to the channel account (`oc_agent_id === accountId`) and POSTs to ST `/generate`
  directly — the agent LLM is NOT in the normal path (ST brain drives, OC body executes). Verified
  end-to-end on fake-ollama (qa-bus → interception → ST → fake-ollama → correct reply).
- **`mock-llm` is unused by every current full-tier test:** the whole 84-test suite passed with
  fake-ollama as the agent model and ZERO agent tool-call requests (even R5/send_message — those run
  `pending_actions` directly, no agent LLM). The agent LLM only fires on the true fallback (no linked
  character) or when the ST character explicitly drives the OC agent.
- **Target A blocked:** forcing the agent path (all chars unlinked) errored
  `No API provider registered for api: ollama`. Our `oc-qa` build (we build it ourselves from OC's
  Dockerfile, base node:24-bookworm, extensions qa-channel,qa-lab) does NOT register an Ollama
  streaming provider. `mock-llm` works only because OC registers `openai-responses`.

**DECISION (Josh): go OpenAI-everywhere.** Both ST and OC speak the OpenAI API. Build ONE
`fake-openai` mock serving `/v1/chat/completions` (+ `/v1/models`), used by BOTH:
- ST: `main_api: openai`, `chat_completion_source: "custom"`, `custom_url` → fake-openai.
- OC: agent provider `api: openai-completions` (registered) → fake-openai. (Or keep openai-responses
  and serve `/v1/responses` too — prefer single endpoint `openai-completions` if it works.)
- `fake-openai` absorbs everything fake-ollama + mock-llm did: sticky `/scenario`, `/reset`,
  `/error-once`, `__DELAY_MS__`, `__INVALID_NDJSON__` (as an OAI analogue), persona-marker echo
  (read `messages[role=system]`), `/last-prompt`, AND the `generate_response` tool-call dance for the
  OC agent path (OAI `tools`/`tool_calls`).
- Delete `mock-llm` AND `fake-ollama`; point all tiers (fast/browser/full) at `fake-openai`.

**First de-risk milestone:** prove ST (headless/quiet) generates via a CUSTOM OpenAI source against a
minimal fake-openai. Everything else is mechanical once that holds.

**P3 progress (2026-06-23):**
- ✅ `docker/fake-openai/` built (server.js + Dockerfile + package.json), on branch
  `feat/unified-fake-ollama` (UNCOMMITTED — files on disk). Serves `/v1/chat/completions` (SSE +
  JSON), `/v1/models`, `/scenario`, `/reset`, `/error-once`, `/last-prompt`, `/pending-count`,
  persona-marker echo (reads `messages[role=system]`), `__DELAY_MS__`/`__INVALID_BODY__` sentinels,
  AND the OC `generate_response` tool-call dance (OAI `tools`/`tool_calls`). Locally validated:
  ST text + persona marker + streaming + OC tool_call args all correct.
- ✅ ST-side de-risk DONE (2026-06-23). ST now generates via the CUSTOM OpenAI source against
  fake-openai end-to-end: `/generate` for TestBot returned the primed scenario
  (`[persona:TestBot] DERISK-OK-42 ribbit!` — system-prompt marker echo confirmed too).
  What it took:
  - `docker/full/sillytavern/settings.json`: `main_api: "openai"` + an `oai_settings` object
    (ST loads `settings.oai_settings ?? settings` and merges per-key over defaults, so only
    overrides are needed): `chat_completion_source: "custom"`, `custom_url:
    "http://fake-openai:11436/v1"` (ST appends `/chat/completions`), `custom_model: "fake-model"`,
    `stream_openai: true`, `bypass_status_check: true`. No API key needed — the CUSTOM source skips
    the key requirement server-side.
  - Added `fake-openai` service to the full compose (port 11436, healthcheck on `/healthz`) and
    pointed `sillytavern-full` depends_on at it. **Healthcheck gotcha:** busybox `wget localhost`
    resolves to `::1` but the server binds IPv4 `0.0.0.0` → use `http://127.0.0.1:11436/healthz`.
  - **Headless connect fix (`st-plugin/headless-service.js`):** `_triggerBackendConnection` clicked
    `#api_button_textgenerationwebui` (Ollama). Chat-completion needs `#api_button_openai`. Without
    this, `generateQuietPrompt()` returns empty and never even calls the LLM (online_status unset).
    After the swap: `Backend connected, online_status: Valid`.
  - CSRF reminder for manual curl de-risks: POST /generate needs `x-csrf-token` from GET
    `/csrf-token` + the cookie jar (the test runner's `stFetch` already does this).
- ✅ DONE (2026-06-23): full P3 consolidation implemented and the full tier is GREEN (85/85)
  via the real qa-bus → OC → ST → fake-openai → qa-bus path. What landed on the branch:
  - OC `openclaw.json` → provider `fake-openai`, `api: openai-completions`,
    `http://fake-openai:11436/v1`, model `fake-model`; agent primary `fake-openai/fake-model`.
  - `mock-llm` service removed from the full compose; `openclaw`/`sillytavern-full` depends_on →
    `fake-openai`. fast/browser compose: the idle `fake-ollama` service removed (those tiers
    generate via `fake-extension`'s WS echo — no real LLM was ever wired to fake-ollama there).
  - test-runner migrated: `FAKE_OPENAI_URL` (default `http://fake-openai:11436`),
    `__INVALID_BODY__` sentinel, textual renames; FULL-PATH-EXCEPTION annotations kept and
    re-pointed at `fake-openai` (still hardcodes target char via `OC_CHARACTER` — P4 promotes).
  - Directories `docker/fake-ollama/` and `docker/full/mock-llm/` deleted.
  - Docs updated: `CLAUDE.md`, `docs/docker-e2e.md`, `docs/development.md`, `package.json` scripts.
- ⏭️ REMAINING for P3: `npm run test:all` four-tier gate (running) → then commit/push/PR
  (commit/PR wording must avoid "phase"/"P3"; describe as "consolidate the two fake LLMs into one
  fake-openai mock"). Josh handles merge. After merge: update memory files
  (`fake_llm_capabilities.md`, `full_tier_invariant.md`) to drop the two-fakes framing.

Blast radius: new `docker/fake-openai/`; ST `settings.json` in full (and fast/browser) tiers; OC
`openclaw.json` provider; compose files for all tiers; delete two fake dirs. Large but mechanical.

---

### Superseded earlier spike note (Target A, kept for context)

## P3 spike findings (research while P2 gate ran — NOT yet executed)

Investigated OC's `api: "ollama"` provider in `~/projects/openclaw`:
- It is a **distinct provider that speaks Ollama's NATIVE API** (`model-preflight.runtime.ts` probes `${baseUrl}/api/tags`; `inline-provider` has a dedicated `ollama` case). It is grouped with `openai-completions` only for local-auth key handling, not for the wire format. So OC's agent on an `ollama` provider calls `${baseUrl}/api/chat` with Ollama-native tool-calling (`tools` in the request, `message.tool_calls` in the response). `image-tool.ollama.live.test.ts` shows OC exercises Ollama tools.
- `fake-ollama` ALREADY serves `/api/chat`, `/api/generate`, `/api/tags`, `/api/version` + the primeable scenario store. So **Target A is clean**: extend `fake-ollama`'s `/api/chat` to do the `generate_response` tool-call dance when it sees the `generate_response` tool (turn 1 → emit Ollama `tool_calls`; turn 2 (tool result present) → emit text). ST calls without tools → returns the primed scenario; OC's agent calls with the tool → does the dance. One process, one shared scenario store, role distinguished by presence of the `tools` array. `mock-llm` is then deleted and OC's provider switches from `openai-responses` (mock-llm) to `ollama` (fake-ollama).
- The `generate_response` contract (`skills/character-bridge/SKILL.md`) already declares `user_name`/`user_avatar`/`images`; the unified mock can forward `user_name` so the demoted user_name/trust tests can be promoted (P4).

**RECOMMENDATION: Target A.** Remaining risk to confirm in the actual spike (needs Docker, after P2): does OC's `ollama` provider fully drive the agentic loop (parse `tool_calls` → execute the bridge tool → send the result back → emit final text)? If a gap appears, fall back to Target B (one server, two API surfaces). **Holding for Josh's go-ahead before executing P3.**

## Verification per phase

Each phase ends green on `npm run test:all` (all four tiers) with no prior regressions, on its own
branch/PR. Infra-only phases (P1) use the documented manual verification above plus a clean
`test:all`. No commits without Josh's explicit pre-commit review.
```
