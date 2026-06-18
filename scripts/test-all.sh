#!/usr/bin/env bash
# test-all.sh — Run all four test tiers in sequence with mandatory image rebuilds.
#
# Why mandatory rebuilds?
#   The full-tier openclaw service uses a named image (openclaw-bridge:oc-full) that
#   docker compose's --rmi local flag does NOT remove, because compose didn't build it
#   (it was built by docker build directly).  Stale OC plugin code has caused repeated
#   false-green full-tier runs.  This script rebuilds everything from scratch so "the
#   image was stale" is structurally impossible.
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
  docker rmi -f openclaw-bridge:oc-full >/dev/null 2>&1 || true
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
  "$@" > "$TMPLOG" 2>&1 && rc=0 || rc=$?
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
    exit 1
  fi
}

# Run a build command, appending to TMPLOG; on failure, show the tail.
run_build() {
  local label="$1"
  shift
  if ! "$@" >> "$TMPLOG" 2>&1; then
    echo "  ✗ $label FAILED"
    echo ""
    echo "--- Build output (last 80 lines) ---"
    tail -80 "$TMPLOG" || true
    exit 1
  fi
}

# ── tier 1: unit ──────────────────────────────────────────────────────────────

if [ "$SKIP_UNIT" = "false" ]; then
  echo "▶ Tier 1/4 — Unit tests..."
  run_tier "Unit" env OPENCLAW_BRIDGE_ENABLE_HEADLESS=false npm test -- --forceExit
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
teardown_full
: > "$TMPLOG"
run_build "oc-full image" docker build -t openclaw-bridge:oc-full -f docker/full/openclaw/Dockerfile .
run_build "full-tier compose build" docker compose -f docker/full/docker-compose.full.yml --profile full-test build
run_tier "Full E2E" docker compose -f docker/full/docker-compose.full.yml --profile full-test run --rm full-test-runner

# ── done ─────────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  All four tiers passed."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
