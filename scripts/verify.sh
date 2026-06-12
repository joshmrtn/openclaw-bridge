#!/usr/bin/env bash
# Verify the openclaw-bridge end-to-end pipeline.
#
# Usage:
#   ./scripts/verify.sh
#   ./scripts/verify.sh --character "Gerard Fontaine"
#   ./scripts/verify.sh --character "Gerard Fontaine" --test
#   ./scripts/verify.sh --st-url http://myserver:8000 --character "Gerard Fontaine"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "${SCRIPT_DIR}")"

ST_URL="${OPENCLAW_BRIDGE_URL:-http://localhost:8000}"
CHARACTER=""
SEND_TEST=0
PASS=0
FAIL=0
WARN=0

usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --character NAME    also verify character link (and optionally test generation)"
    echo "  --st-url URL        ST base URL (default: \$OPENCLAW_BRIDGE_URL or http://localhost:8000)"
    echo "  --test              send a test /generate request (requires --character)"
    echo "  --help              show this help"
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --character) CHARACTER="$2"; shift 2 ;;
        --st-url)    ST_URL="$2"; shift 2 ;;
        --test)      SEND_TEST=1; shift ;;
        --help|-h)   usage ;;
        *) echo "Unknown option: $1" >&2; usage ;;
    esac
done

# Load token
TOKEN_FILE="${REPO_DIR}/data/openclaw-bridge/bridge-token.txt"
if [ -n "${OPENCLAW_BRIDGE_TOKEN:-}" ]; then
    TOKEN="${OPENCLAW_BRIDGE_TOKEN}"
elif [ -f "${TOKEN_FILE}" ]; then
    TOKEN="$(cat "${TOKEN_FILE}")"
else
    echo "ERROR: No bridge token found." >&2
    echo "  Set OPENCLAW_BRIDGE_TOKEN env var, or run ./setup.sh to generate one." >&2
    exit 1
fi

PLUGIN_BASE="${ST_URL}/api/plugins/openclaw-bridge"

ok()   { echo "  [OK]   $1"; PASS=$((PASS + 1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  [WARN] $1"; WARN=$((WARN + 1)); }
info() { echo "         $1"; }

curl_get() {
    curl -sS --max-time 8 "$1" -H "Authorization: Bearer ${TOKEN}" 2>/dev/null \
        || echo '{"_error":"curl failed"}'
}

curl_post() {
    local url="$1" body="$2"
    curl -sS --max-time 30 -X POST "${url}" \
        -H "Authorization: Bearer ${TOKEN}" \
        -H "Content-Type: application/json" \
        -d "${body}" 2>/dev/null \
        || echo '{"_error":"curl failed"}'
}

# Extract a numeric field from a flat JSON blob
json_num() {
    echo "$2" | grep -o "\"$1\":[0-9]*" | head -1 | cut -d: -f2 || echo "0"
}

# Check if JSON blob contains a literal substring
json_has() {
    echo "$2" | grep -q "$1"
}

echo "=== openclaw-bridge pipeline verification ==="
echo "ST URL:    ${ST_URL}"
[ -n "${CHARACTER}" ] && echo "Character: ${CHARACTER}"
echo ""

# ── 1. Plugin ─────────────────────────────────────────────────────────────────
echo "── ST plugin ──────────────────────────────────────────────────────"
STATUS=$(curl_get "${PLUGIN_BASE}/status")

if json_has '"status":"ok"' "${STATUS}"; then
    VER=$(echo "${STATUS}" | grep -o '"version":"[^"]*"' | cut -d'"' -f4 || echo "?")
    ok "Plugin loaded (v${VER})"
else
    fail "Plugin not loaded or ST not reachable at ${ST_URL}"
    info "Check that SillyTavern is running and the plugin is installed."
    info "Response: ${STATUS}"
    echo ""
    echo "=== Cannot continue — ST plugin must be running. ==="
    exit 1
fi

# ── 2. Clients & headless ─────────────────────────────────────────────────────
echo ""
echo "── Clients & headless ─────────────────────────────────────────────"
HEALTH=$(curl_get "${PLUGIN_BASE}/health")

WS_COUNT=$(json_num connected_ws_clients "${STATUS}")
if [ "${WS_COUNT:-0}" -gt 0 ] 2>/dev/null; then
    ok "WS clients connected: ${WS_COUNT}"
else
    fail "No WS clients connected (headless not yet ready, or Playwright missing)"
    info "Generation will fail until a browser extension or headless client connects."
    info "Wait ~30 s for the headless service to start, then re-run this script."
fi

if json_has '"isConnected":true' "${HEALTH}"; then
    ok "Headless service connected"
elif json_has '"isReconnecting":true' "${HEALTH}"; then
    warn "Headless service is reconnecting — wait and retry"
elif json_has '"isRunning":true' "${HEALTH}"; then
    warn "Headless service running but extension not yet connected"
else
    warn "Headless service not running (Playwright not installed, or OPENCLAW_BRIDGE_ENABLE_HEADLESS=false)"
    info "Install Playwright: cd st-plugin && npx playwright install chromium"
fi

# ── 3. Character (optional) ───────────────────────────────────────────────────
if [ -n "${CHARACTER}" ]; then
    echo ""
    echo "── Character link ─────────────────────────────────────────────────"
    CHARS=$(curl_get "${PLUGIN_BASE}/characters")

    # Use python3 for URL encoding if available, otherwise pass raw (works for most names)
    if command -v python3 >/dev/null 2>&1; then
        ENC_CHAR=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "${CHARACTER}" 2>/dev/null || echo "${CHARACTER}")
    else
        ENC_CHAR="${CHARACTER}"
    fi

    if json_has "\"name\":\"${CHARACTER}\"" "${CHARS}"; then
        ACTIVE=$(echo "${CHARS}" | grep -A10 "\"name\":\"${CHARACTER}\"" \
            | grep '"active"' | grep -o 'true\|false' | head -1 || echo "unknown")
        if [ "${ACTIVE}" = "true" ]; then
            ok "Character '${CHARACTER}' linked and active"
        else
            warn "Character '${CHARACTER}' linked but not active"
            info "Set active:true via ./scripts/link-character.sh or the /characters/:name/link endpoint"
        fi
    else
        fail "Character '${CHARACTER}' is not linked"
        info "Run: ./scripts/link-character.sh --character \"${CHARACTER}\" --agent <agentname>"
    fi

    # ── 4. Test generate (optional) ───────────────────────────────────────────
    if [ "${SEND_TEST}" -eq 1 ]; then
        echo ""
        echo "── Test generate ──────────────────────────────────────────────────"
        if [ "${WS_COUNT:-0}" -eq 0 ] 2>/dev/null; then
            warn "Skipping test generate — no WS clients connected"
        else
            echo "  Sending /generate for '${CHARACTER}' (may take up to 60 s)..."
            BODY="{\"character\":\"${CHARACTER}\",\"message\":\"Reply with the single word OK.\",\"user_id\":\"verify:test\"}"
            GEN=$(curl_post "${PLUGIN_BASE}/generate" "${BODY}")
            if json_has '"response"' "${GEN}"; then
                ok "Generation succeeded"
                RESP=$(echo "${GEN}" | grep -o '"response":"[^"]*"' | cut -d'"' -f4 | head -c 120 || echo "?")
                info "Response: ${RESP}"
            else
                fail "Generation failed"
                info "Response: ${GEN}"
            fi
        fi
    fi
fi

# ── 5. OpenClaw gateway ───────────────────────────────────────────────────────
echo ""
echo "── OpenClaw gateway ───────────────────────────────────────────────"
OC_OK=0
if command -v openclaw >/dev/null 2>&1; then
    if openclaw health >/dev/null 2>&1; then
        ok "OpenClaw gateway reachable"
        OC_OK=1
    fi
fi
if [ "${OC_OK}" -eq 0 ] && command -v curl >/dev/null 2>&1; then
    if curl -sS --max-time 3 http://localhost:18789/health >/dev/null 2>&1; then
        ok "OpenClaw gateway reachable (localhost:18789)"
        OC_OK=1
    fi
fi
if [ "${OC_OK}" -eq 0 ]; then
    warn "OpenClaw gateway not reachable — bridge cannot receive messages from OC channels"
    info "Start OC: openclaw gateway start"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=== ${PASS} passed · ${FAIL} failed · ${WARN} warnings ==="

[ "${FAIL}" -gt 0 ] && exit 1 || exit 0
