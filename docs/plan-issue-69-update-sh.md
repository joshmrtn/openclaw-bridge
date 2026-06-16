# Plan: Issue #69 — update.sh

## Goal

A single `update.sh` that a non-technical user can run to pull in a patch and have
everything correctly updated: git pull, self-re-exec if the script itself changed, npm
install, OC plugin recompile, schema migrations, redeploy to ST and OC, restart
instructions. Companion change: `setup.sh` persists the ST install path and seeds the
schema version file so `update.sh` has what it needs on first run.

## Branch

`feat/issue-69`

---

## Architecture decisions locked in

### Self-re-exec after git pull
After `git pull`, compare pre/post HEAD and diff `update.sh`. If it changed, `exec` the
new version with the same `$@`. This means running the old script once is always
sufficient, even if the patch being applied is a fix to the script itself.

### Schema migrations: numbered scripts in `migrations/`
Each data-schema change ships as `migrations/NNNN_description.sh`. A
`data/openclaw-bridge/schema-version.txt` file tracks the last applied migration number.
`update.sh` runs any migration with NNNN > current version, bumping the version file
after each success. Partial-run failures are safe to re-run (each migration must be
idempotent). The plugin startup code does not perform migrations; it warns if it detects
a stale schema version (future work — not in scope for this issue).

### OC plugin tsc: add typescript as a devDep to oc-plugin
Currently tsc is sourced from OC's own node_modules, which requires knowing OC's install
path. Instead, add `typescript` as a devDependency to `oc-plugin/package.json` and run
`npm install` in oc-plugin during updates. The script can then use
`oc-plugin/node_modules/.bin/tsc` as a reliable, self-contained path.

### OC plugin update: copy dist/, not re-run openclaw plugins install
The CLI install command is intended for first-time setup. Updates only need to push the
newly compiled `dist/` output. `update.sh` copies `oc-plugin/dist/` to
`~/.openclaw/extensions/openclaw-bridge/dist/` (guarded — warn and skip if the installed
path does not exist rather than silently creating it in the wrong place).

### ST path persistence
`setup.sh` writes `st_path=<resolved_path>` to `data/openclaw-bridge/config` after a
successful install. `update.sh` sources this file. If the file does not exist (user
installed before this change), `update.sh` falls back to the same auto-discovery logic as
`setup.sh` and saves the result for next time. `--st-path` always overrides and saves.

---

## Testing strategy

### What the Docker E2E covers

The update.sh tests slot into the full-tier lifecycle suite
(`docker/full/test-runner/full-e2e.test.js`) as a new `describe('update.sh lifecycle
(#69)')` block, placed after the existing `setup.sh → uninstall.sh lifecycle` block.

The sillytavern Dockerfile excludes `.git/` (see `.dockerignore`), so `git pull`, the
dirty-tree check, and the self-re-exec step cannot run inside the container. The script
needs a `--skip-pull` flag that bypasses those three steps. E2E tests pass `--skip-pull`
and focus on the deployment steps that are fully exercisable in the container:

| Scenario | How |
|---|---|
| Stale ST install is refreshed | Remove `index.js` from installed plugin dir; run update.sh; assert file is back |
| Pending migrations run and version is bumped | Write `0` to `schema-version.txt`; run update.sh; assert version ≥ 1 |
| System is healthy after update | Run verify.sh after update and assert `0 failed` |
| `--skip-oc` doesn't crash | No OC CLI in container; flag suppresses OC steps cleanly |

The container tests always pass `--skip-pull --skip-oc --st-path /home/node/app --yes`.

### What is manual-only

- **git pull itself** — standard shell; trust git
- **Dirty-tree check** — manually dirty the tree, run update.sh, confirm error message and
  stash/reset hints appear, then verify clean run succeeds
- **Self-re-exec** — modify update.sh, stage a pull, confirm exec fires; this is hard to
  automate and the code path is short enough to review carefully instead

---

## Phases

### Phase 1 — oc-plugin typescript devDep

**Why first:** `update.sh` needs a reliable tsc. Establishing this before writing the
script avoids a circular dependency in the plan.

Changes:
- Add `"typescript": "^5"` to `devDependencies` in `oc-plugin/package.json`
- Run `npm install` inside `oc-plugin/` to produce `oc-plugin/node_modules/`
- Add `oc-plugin/node_modules/` to `.gitignore` (or confirm it's already excluded)
- Verify: `oc-plugin/node_modules/.bin/tsc --version` prints a version number
- Verify: `oc-plugin/node_modules/.bin/tsc --project oc-plugin/tsconfig.json` produces
  `dist/index.js` as before

No Jest tests — this is a build toolchain change. Manual verification is sufficient.

---

### Phase 2 — setup.sh: persist config + seed schema version

Changes to `setup.sh`:
- After `install_into_st()` succeeds, write/overwrite `data/openclaw-bridge/config`:
  ```
  st_path=/resolved/absolute/path
  ```
- After creating the data dir (which already happens): write `1` to
  `data/openclaw-bridge/schema-version.txt` **only if it does not already exist**
  (idempotent re-runs of setup.sh must not regress the version).
- If `--skip-st` is passed, still write `schema-version.txt` but leave `config` with no
  `st_path` key (update.sh will fall back to discovery).

Verification (manual):
- Run `./setup.sh --st-path /tmp/fake-st --yes` (with fake dir containing plugins/ and
  public/scripts/extensions/)
- Confirm `data/openclaw-bridge/config` contains `st_path=/tmp/fake-st`
- Confirm `data/openclaw-bridge/schema-version.txt` contains `1`
- Re-run — confirm version file still contains `1` (not incremented)

---

### Phase 3 — migrations/ directory and baseline migration

New files:
- `migrations/0001_baseline.sh` — documents the v1 schema in comments, makes no data
  changes, exits 0. This is the anchor: "schema version 1 = what shipped with v1.0."

`migrations/0001_baseline.sh` contract:
- Receives data dir as `$1`
- Is idempotent (safe to run multiple times)
- Prints a single confirmation line and exits 0

Verification (manual):
- `bash migrations/0001_baseline.sh data/openclaw-bridge` — exits 0, prints confirmation
- Run it twice — same result

---

### Phase 4 — update.sh

Full script at repo root. Flags: `--st-path`, `--yes/-y`, `--skip-st`, `--skip-oc`,
`--skip-pull`, `--help`.

`--skip-pull` bypasses step 3 (dirty check), step 4 (git pull), and step 5
(self-re-exec). Used by E2E tests (container has no `.git/`) and also useful for users
who want to update after manually checking out a specific version.

**Mac portability requirements (enforced during implementation):**
- No `sort -V` — zero-padded migration filenames make plain `sort` correct
- No `sed -i` without a backup suffix — use `printf` or `echo >` for writing version files
- No `readlink -f` — use `cd ... && pwd` pattern (already established in setup.sh)
- No GNU-specific flags to `stat`, `date`, `find`, or `cp`
- Shebang is `#!/usr/bin/env bash` (not `/bin/bash`)
- All features must work under bash 3.2 (macOS ships this; no `declare -A`, no `mapfile`)
- Manual verification on macOS is required before the PR is merged

Steps in order:

1. **Arg parsing** — same style as setup.sh
2. **Prereq checks** — node version, openclaw CLI present, tsc present at
   `oc-plugin/node_modules/.bin/tsc`
3. **Dirty-tree check**
   ```bash
   if ! git diff --quiet || ! git diff --cached --quiet; then
       echo "Error: uncommitted local changes detected."
       echo "To stash:  git stash"
       echo "To reset:  git reset --hard HEAD && git clean -fd"
       exit 1
   fi
   ```
4. **git pull --ff-only** — if it fails (diverged history), print a clear message and
   exit; do not attempt merge
5. **Self-re-exec check** — diff `update.sh` between old and new HEAD; exec new version
   with original `$@` if changed
6. **npm install** — in `st-plugin/` and in `oc-plugin/` (covers both dep sets)
7. **OC TypeScript recompile** —
   `oc-plugin/node_modules/.bin/tsc --project oc-plugin/tsconfig.json`
8. **Migration runner** — read `schema-version.txt` (default 0 if missing); for each
   `migrations/NNNN_*.sh` in sorted order where NNNN > current version: run it, on
   success write NNNN to `schema-version.txt`; on failure print error and exit 1
9. **OC plugin dist copy** — if `~/.openclaw/extensions/openclaw-bridge/` exists, copy
   `oc-plugin/dist/` into it; if not, warn with manual instruction (do not create
   silently)
10. **ST plugin + extension copy** — resolve ST path: `--st-path` > `config` file >
    auto-discovery > prompt (interactive) > skip with warning; if resolved, call
    `install_into_st()`; save resolved path back to `config`
11. **Restart checklist** — print what the user needs to restart (OC, ST, browser
    refresh)

Verification (manual, against a local checkout):
- Confirm each step executes in order and produces correct output
- Simulate dirty tree: create a file, confirm exit with correct message and hints
- Simulate update.sh change: temporarily modify the script after pull check to confirm
  exec path triggers (tricky to test — review logic carefully instead)
- Simulate migration: add a dummy `migrations/0002_test.sh`, confirm it runs and bumps
  the version file

---

### Phase 5 — Full E2E tests

Add `describe('update.sh lifecycle (#69)')` to `full-e2e.test.js` after the existing
setup/uninstall lifecycle block.

**Why the OC copy step is testable without `--skip-oc`:** the copy step only checks
whether `~/.openclaw/extensions/openclaw-bridge/` exists, not whether the `openclaw`
CLI is present. A test can pre-create a fake install dir and exercise the copy without
a real OC installation. The CLI prereq check warns but does not abort.

Tests:

1. **Stale ST install is refreshed**: remove `index.js` from installed plugin dir; run
   update.sh with `--skip-pull --skip-oc`; assert file is restored; assert `verify.sh`
   reports `0 failed` after ST restart.
2. **Pending migration runs and version is bumped**: write `0` to `schema-version.txt`;
   run update.sh with `--skip-pull --skip-oc`; assert version ≥ 1.
3. **OC dist copy works**: pre-create `~/.openclaw/extensions/openclaw-bridge/dist/` in
   the container; corrupt/remove `dist/index.js` from that dir; run update.sh with
   `--skip-pull` (no `--skip-oc`); assert `dist/index.js` is restored.
4. **Idempotency**: run update.sh twice back-to-back with `--skip-pull --skip-oc`; assert
   both exits are 0 and schema version is unchanged on the second run.

Tests 1, 2, 4 use `--skip-pull --skip-oc --st-path /home/node/app --yes`.
Test 3 uses `--skip-pull --st-path /home/node/app --yes` (no `--skip-oc`).

### Phase 6 — README update

- Add an "Updating" section alongside the "Installing" section
- Document: run `./update.sh`; it reads the ST path from setup; use `--st-path` if ST
  moved
- Note: OC and ST must be restarted after the update (script will say this too)

---

## Files changed

| File | Change |
|---|---|
| `oc-plugin/package.json` | Add typescript devDep |
| `oc-plugin/node_modules/` | Generated; add to .gitignore |
| `setup.sh` | Persist st_path to config; seed schema-version.txt |
| `migrations/0001_baseline.sh` | New — baseline no-op migration |
| `update.sh` | New — main update script |
| `docker/full/test-runner/full-e2e.test.js` | Add update.sh lifecycle describe block |
| `README.md` | Add updating section |

## Out of scope

- Schema migration logic in plugin startup (future work)
- Plugin startup warning on version mismatch (future work)
- Clawhub / OC registry distribution (separate issue)
- Rollback support (out of scope for v1)
