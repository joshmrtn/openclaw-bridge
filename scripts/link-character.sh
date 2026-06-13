#!/usr/bin/env bash
# link-character.sh — Register a SillyTavern character with an OC agent in the bridge plugin.
#
# Usage:
#   ./scripts/link-character.sh --character "Frog" --agent frog \
#     --owner "discord:123456789" [--owner "telegram:987654321"] \
#     [--plugin-url http://localhost:8000] [--token YOUR_TOKEN]
#
# Options:
#   --character              Exact ST character name (case-sensitive)
#   --agent                  OC agent ID (e.g. "frog")
#   --owner                  Owner user ID in "platform:id" format; repeat for multiple owners
#   --plugin-url             Base URL of the ST plugin (default: http://localhost:8000)
#   --token                  Bridge auth token (default: read from data/openclaw-bridge/bridge-token.txt)
#   --unlink                 Remove the link instead of creating/updating it
#   --heartbeat-channel ID   OC channel account ID for heartbeat posts (required to enable heartbeat)
#   --heartbeat-interval-ms  Scheduled heartbeat interval in ms (default: 7200000 / 2h)
#   --heartbeat-idle-ms      Idle-trigger threshold in ms; 0 = disabled (default: 7200000 / 2h)
#   --heartbeat-prompt TEXT  Custom heartbeat prompt (default: set by skill)
#   --heartbeat-target ID    Target channel or user for heartbeat posts (optional)
#   --heartbeat-account ID   OC account ID for multi-account deployments (optional)
#   --disable-heartbeat      Remove existing heartbeat config from this character

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname "${script_dir}")"

PLUGIN_URL="${OPENCLAW_BRIDGE_URL:-http://localhost:8000}"
TOKEN="${OPENCLAW_BRIDGE_TOKEN:-${OPENCLAW_BRIDGE_AUTH_TOKEN:-}}"
CHARACTER=""
AGENT_ID=""
UNLINK=false
declare -a OWNER_IDS=()

HEARTBEAT_CHANNEL=""
HEARTBEAT_INTERVAL_MS=""
HEARTBEAT_IDLE_MS=""
HEARTBEAT_PROMPT=""
HEARTBEAT_TARGET=""
HEARTBEAT_ACCOUNT=""
DISABLE_HEARTBEAT=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --character) CHARACTER="$2"; shift 2 ;;
        --agent)     AGENT_ID="$2";  shift 2 ;;
        --owner)     OWNER_IDS+=("$2"); shift 2 ;;
        --plugin-url) PLUGIN_URL="$2"; shift 2 ;;
        --token)     TOKEN="$2"; shift 2 ;;
        --unlink)    UNLINK=true; shift ;;
        --heartbeat-channel)     HEARTBEAT_CHANNEL="$2"; shift 2 ;;
        --heartbeat-interval-ms) HEARTBEAT_INTERVAL_MS="$2"; shift 2 ;;
        --heartbeat-idle-ms)     HEARTBEAT_IDLE_MS="$2"; shift 2 ;;
        --heartbeat-prompt)      HEARTBEAT_PROMPT="$2"; shift 2 ;;
        --heartbeat-target)      HEARTBEAT_TARGET="$2"; shift 2 ;;
        --heartbeat-account)     HEARTBEAT_ACCOUNT="$2"; shift 2 ;;
        --disable-heartbeat)     DISABLE_HEARTBEAT=true; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# Auto-load token from data directory if not set
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

if [[ -z "${CHARACTER}" ]]; then
    echo "Error: --character is required" >&2
    exit 1
fi

# URL-encode the character name (spaces → %20, etc.)
encoded_name="$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "${CHARACTER}" 2>/dev/null \
    || printf '%s' "${CHARACTER}" | sed 's/ /%20/g; s/&/%26/g; s/?/%3F/g')"

endpoint="${PLUGIN_URL}/api/plugins/openclaw-bridge/characters/${encoded_name}/link"

if [[ "${UNLINK}" == true ]]; then
    echo "Removing link for '${CHARACTER}'..."
    curl -sS -X DELETE "${endpoint}" \
        -H "Authorization: Bearer ${TOKEN}" \
        -H "Content-Type: application/json" | python3 -m json.tool 2>/dev/null || true
    echo
    echo "Done."
    exit 0
fi

if [[ -z "${AGENT_ID}" ]]; then
    echo "Error: --agent is required" >&2
    exit 1
fi

# Validate heartbeat flags
if [[ "${DISABLE_HEARTBEAT}" == false && -n "${HEARTBEAT_CHANNEL}${HEARTBEAT_INTERVAL_MS}${HEARTBEAT_IDLE_MS}${HEARTBEAT_PROMPT}${HEARTBEAT_TARGET}${HEARTBEAT_ACCOUNT}" ]]; then
    if [[ -z "${HEARTBEAT_CHANNEL}" ]]; then
        echo "Error: --heartbeat-channel is required when configuring heartbeat" >&2
        exit 1
    fi
fi

# Build owner_user_ids JSON array
owner_json="["
first=true
for oid in "${OWNER_IDS[@]+"${OWNER_IDS[@]}"}"; do
    if [[ "${first}" == true ]]; then
        first=false
    else
        owner_json+=","
    fi
    owner_json+="\"${oid}\""
done
owner_json+="]"

# Determine if any heartbeat flags were passed
HEARTBEAT_GIVEN=false
if [[ "${DISABLE_HEARTBEAT}" == true || -n "${HEARTBEAT_CHANNEL}" || -n "${HEARTBEAT_INTERVAL_MS}" || \
      -n "${HEARTBEAT_IDLE_MS}" || -n "${HEARTBEAT_PROMPT}" || -n "${HEARTBEAT_TARGET}" || \
      -n "${HEARTBEAT_ACCOUNT}" ]]; then
    HEARTBEAT_GIVEN=true
fi

if [[ "${HEARTBEAT_GIVEN}" == true ]]; then
    # Use python3 to safely build JSON (handles prompt escaping and numeric fields)
    body=$(python3 -c "
import json, sys

disable   = sys.argv[1] == 'true'
agent_id  = sys.argv[2]
owners    = json.loads(sys.argv[3])
channel   = sys.argv[4]
interval  = sys.argv[5]
idle      = sys.argv[6]
prompt    = sys.argv[7]
target    = sys.argv[8]
account   = sys.argv[9]

data = {'oc_agent_id': agent_id, 'owner_user_ids': owners}

if disable:
    data['heartbeat'] = None
else:
    hb = {'enabled': True, 'channel_id': channel}
    if interval: hb['interval_ms'] = int(interval)
    if idle:     hb['idle_threshold_ms'] = int(idle)
    if prompt:   hb['prompt'] = prompt
    if target:   hb['target'] = target
    if account:  hb['account_id'] = account
    data['heartbeat'] = hb

print(json.dumps(data))
" \
    "${DISABLE_HEARTBEAT}" \
    "${AGENT_ID}" \
    "${owner_json}" \
    "${HEARTBEAT_CHANNEL}" \
    "${HEARTBEAT_INTERVAL_MS}" \
    "${HEARTBEAT_IDLE_MS}" \
    "${HEARTBEAT_PROMPT}" \
    "${HEARTBEAT_TARGET}" \
    "${HEARTBEAT_ACCOUNT}")
else
    body="{\"oc_agent_id\":\"${AGENT_ID}\",\"owner_user_ids\":${owner_json}}"
fi

echo "Linking '${CHARACTER}' → agent '${AGENT_ID}'..."
if [[ ${#OWNER_IDS[@]} -gt 0 ]]; then
    echo "Owners: ${OWNER_IDS[*]}"
fi
if [[ "${DISABLE_HEARTBEAT}" == true ]]; then
    echo "Heartbeat: disabling"
elif [[ -n "${HEARTBEAT_CHANNEL}" ]]; then
    echo "Heartbeat: enabled on channel '${HEARTBEAT_CHANNEL}'"
fi
echo

response=$(curl -sS -w "\n%{http_code}" -X POST "${endpoint}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${body}")

http_code="${response##*$'\n'}"
body_out="${response%$'\n'*}"

echo "${body_out}" | python3 -m json.tool 2>/dev/null || echo "${body_out}"
echo

if [[ "${http_code}" -ge 200 && "${http_code}" -lt 300 ]]; then
    echo "Linked successfully."
else
    echo "Error: HTTP ${http_code}" >&2
    exit 1
fi
