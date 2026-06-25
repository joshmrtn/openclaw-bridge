#!/usr/bin/env bash
# reload-headless.sh — Trigger a headless browser reload in the ST plugin.
#
# Run this after changing the LLM, API endpoint, or character settings in the
# ST UI so the headless browser picks up the new configuration.
#
# Usage:
#   ./scripts/reload-headless.sh [--plugin-url URL] [--token TOKEN]
#
# Options:
#   --plugin-url URL   Base URL of the ST plugin (default: http://localhost:8000)
#   --token TOKEN      Bridge auth token (default: read from data/openclaw-bridge/bridge-token.txt)

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname "${script_dir}")"

PLUGIN_URL="${OPENCLAW_BRIDGE_URL:-http://localhost:8000}"
TOKEN="${OPENCLAW_BRIDGE_TOKEN:-${OPENCLAW_BRIDGE_AUTH_TOKEN:-}}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --plugin-url) PLUGIN_URL="$2"; shift 2 ;;
        --token)      TOKEN="$2";      shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "${TOKEN}" ]]; then
    token_file="${repo_root}/data/openclaw-bridge/bridge-token.txt"
    if [[ -f "${token_file}" ]]; then
        TOKEN="$(cat "${token_file}")"
    fi
fi

if [[ -z "${TOKEN}" ]]; then
    echo "Error: bridge token not found. Set OPENCLAW_BRIDGE_TOKEN or run ./setup.sh first." >&2
    exit 1
fi

# ST enforces CSRF on plugin POST routes even for Bearer clients, so fetch a
# token (with a cookie jar) and send it — the same flow the OC plugin uses.
# Harmless when CSRF is disabled: the token is simply empty and ignored.
cookie_jar="$(mktemp)"
trap 'rm -f "${cookie_jar}"' EXIT
csrf_token="$(curl -sS -c "${cookie_jar}" "${PLUGIN_URL}/csrf-token" 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null || true)"

response=$(curl -sS -w "\n%{http_code}" -X POST \
    "${PLUGIN_URL}/api/plugins/openclaw-bridge/reload-headless" \
    -b "${cookie_jar}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "X-CSRF-Token: ${csrf_token}" \
    -H "Content-Type: application/json")

http_code="${response##*$'\n'}"
body="${response%$'\n'*}"

echo "${body}" | python3 -m json.tool 2>/dev/null || echo "${body}"
echo

if [[ "${http_code}" -ge 200 && "${http_code}" -lt 300 ]]; then
    echo "Headless browser reloaded."
else
    echo "Error: HTTP ${http_code}" >&2
    exit 1
fi
