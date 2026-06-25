#!/usr/bin/env bash
# test-all.sh — Run all four test tiers in sequence with mandatory image rebuilds.
#
# Why mandatory rebuilds?
#   Stale full-tier images have caused repeated false-green runs. Every tier here is
#   rebuilt by `docker compose build` before it runs, so "the image was stale" is
#   structurally impossible. The openclaw service has a build: stanza, so compose
#   rebuilds oc-full via content-addressed caching (a change to oc-plugin busts its
#   COPY layer) — no force-rmi needed. The only image compose can't build is the
#   oc-qa base (built from the external OpenClaw repo by build-oc.sh); it is a
#   one-time prerequisite and is preflight-checked before tier 4.
#
# Usage:
#   ./scripts/test-all.sh             # run all four tiers
#   ./scripts/test-all.sh --skip-unit # skip the unit tier (faster inner loop)
#
# Output: one summary line per tier on success; failure details on first failing tier.
# Exit codes: 0 = all pass, non-zero = first failing tier.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SKIP_UNIT=false
for arg in "$@"; do
  case "$arg" in
    --skip-unit) SKIP_UNIT=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

TMPLOG=$(mktemp /tmp/test-all-XXXXXX.log)
trap 'rm -f "$TMPLOG"' EXIT
LOGFILE=/tmp/test-all.log
: > "$LOGFILE"

# Guard: Docker image rebuilds need headroom; fail early with a clear message.
avail_kb=$(df -k / | awk 'NR==2 {print $4}')
if [ "$avail_kb" -lt 4194304 ]; then  # 4 GB
  echo "✗ Only $((avail_kb / 1024))MB free on /. Need at least 4 GB." >&2
  echo "  Run: docker system prune -f --volumes && docker builder prune -f" >&2
  exit 1
fi

# ── helpers ───────────────────────────────────────────────────────────────────

teardown_shared() {
  docker compose -f docker/docker-compose.yml down --remove-orphans --rmi local --volumes >/dev/null 2>&1 || true
}

teardown_full() {
  docker compose -f docker/full/docker-compose.full.yml down --remove-orphans --rmi local --volumes >/dev/null 2>&1 || true
  docker rm -f openclaw-bridge-e2e-full-link-setup-1 \
               openclaw-bridge-e2e-full-character-links-init-1 >/dev/null 2>&1 || true
  # Note: oc-full is intentionally NOT force-removed. The openclaw service now has a
  # build: stanza, so `docker compose build` below rebuilds it via content-addressed
  # caching (the COPY layer busts when oc-plugin changes). Keeping the image between
  # runs reuses the cache for a faster, still-never-stale rebuild.
}

# Print FAIL/PASS file lines, Jest ● error blocks, or log tail on build failure.
show_failures() {
  local log="$1"
  if grep -qE "^(FAIL|PASS) " "$log" 2>/dev/null; then
    grep -E "^(FAIL|PASS) " "$log" || true
    echo ""
    if grep -q "^●" "$log" 2>/dev/null; then
      echo "--- Failure details ---"
      sed -n '/^●/,/^Tests:/p' "$log" | grep -v "^Tests:" | head -200 || true
    fi
  else
    echo "--- Output (last 80 lines) ---"
    tail -80 "$log" || true
  fi
}

# Run a command with all output captured; print one-line summary on pass, details on fail.
run_tier() {
  local tier="$1"
  local rc
  shift
  "$@" 2>&1 | tee -a "$LOGFILE" > "$TMPLOG"
  rc=${PIPESTATUS[0]}
  # Strip ANSI codes: Jest uses --colors; Playwright also emits them.
  sed -i $'s/\033\\[[0-9;]*[A-Za-z]//g' "$TMPLOG"
  if [ "$rc" -eq 0 ]; then
    # Jest output: "Tests: N passed, N total"
    # Playwright output: "  N passed (Xm)" — grep -o extracts just the matching text.
    local summary
    summary=$(grep -E "^Tests:" "$TMPLOG" | tail -1 || true)
    [ -z "$summary" ] && summary=$(grep -oE "[0-9]+ passed \([^)]+\)" "$TMPLOG" | tail -1 || true)
    echo "  ✓ $tier: $summary"
  else
    echo "  ✗ $tier FAILED"
    echo ""
    show_failures "$TMPLOG" || true
    echo ""
    echo "  Full log: $LOGFILE"
    echo "  Hint: grep -E 'FAIL|^●' $LOGFILE"
    exit 1
  fi
}

# Run a build command, appending to TMPLOG; on failure, show the tail.
run_build() {
  local label="$1"
  shift
  "$@" 2>&1 | tee -a "$LOGFILE" >> "$TMPLOG"
  if [ "${PIPESTATUS[0]}" -ne 0 ]; then
    echo "  ✗ $label FAILED"
    echo ""
    echo "--- Build output (last 80 lines) ---"
    tail -80 "$TMPLOG" || true
    echo ""
    echo "  Full log: $LOGFILE"
    exit 1
  fi
}

# ── tier 1: unit ──────────────────────────────────────────────────────────────

if [ "$SKIP_UNIT" = "false" ]; then
  echo "▶ Tier 1/4 — Unit tests..."
  run_tier "Unit (jest)" env OPENCLAW_BRIDGE_ENABLE_HEADLESS=false npm test -- --forceExit
  # oc-plugin ships its own vitest suite with a separate node_modules/lockfile, so it
  # is not covered by the jest run above. Ensure its deps are present, then run it as
  # part of the unit tier so the oc-plugin retry/format tests actually gate.
  [ -x oc-plugin/node_modules/.bin/vitest ] || run_build "oc-plugin deps" npm --prefix oc-plugin ci
  run_tier "Unit (oc-plugin vitest)" npm --prefix oc-plugin test
fi

# ── tier 2: fast E2E ──────────────────────────────────────────────────────────

echo "▶ Tier 2/4 — Fast E2E (Docker)..."
teardown_shared
run_tier "Fast E2E" docker compose -f docker/docker-compose.yml --profile test run --build --rm test-runner

# ── tier 3: browser E2E ───────────────────────────────────────────────────────

echo "▶ Tier 3/4 — Browser E2E (Docker)..."
teardown_shared
run_tier "Browser E2E" docker compose -f docker/docker-compose.yml --profile browser-test run --build --rm browser-test-runner

teardown_shared

# ── tier 4: full E2E ──────────────────────────────────────────────────────────

echo "▶ Tier 4/4 — Full E2E (Docker)..."
# The oc-qa base image is built from the external OpenClaw repo (build-oc.sh) and
# cannot be built by compose — it is a one-time prerequisite. oc-full and every
# other full-tier image are rebuilt below by `docker compose build`.
if ! docker image inspect openclaw-bridge:oc-qa >/dev/null 2>&1; then
  echo "  ✗ Full E2E: base image openclaw-bridge:oc-qa is missing." >&2
  echo "    Build it once (needs the OpenClaw repo): npm run docker:full:build-oc" >&2
  exit 1
fi
teardown_full
: > "$TMPLOG"
run_build "full-tier compose build" docker compose -f docker/full/docker-compose.full.yml --profile full-test build
run_tier "Full E2E" docker compose -f docker/full/docker-compose.full.yml --profile full-test run --rm full-test-runner

# ── done ─────────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  All four tiers passed."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
