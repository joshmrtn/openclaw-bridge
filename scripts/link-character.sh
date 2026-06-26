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
#   --heartbeat-target ID    Raw recipient for heartbeat posts: channel id, or your user id when --heartbeat-kind dm
#   --heartbeat-kind KIND    dm|channel — dm = the heartbeat DMs you; channel = posts to the channel (default: channel)
#   --heartbeat-account ID   OC account ID for multi-account deployments (optional)
#   --disable-heartbeat      Remove existing heartbeat config from this character
#   --channel NAME              Logical channel name the character uses in send_message (e.g. "dm", "the-pond"); repeat for multiple
#   --channel-id ID             OC channel/adapter id paired with --channel (e.g. "discord") — which bot/platform to send through
#   --channel-kind dm|channel   How to deliver: "dm" = direct-message the recipient; "channel" = post to the channel
#   --channel-recipient ID      Raw recipient id: your user id for dm, the channel id for channel
#   --remove-channel NAME       Remove a channel entry by name; repeat for multiple
#   --help, -h               Show this help with examples and exit

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
HEARTBEAT_KIND=""
HEARTBEAT_ACCOUNT=""
DISABLE_HEARTBEAT=false

# Channel flags — parallel arrays: CHANNEL_NAMES[i] pairs with CHANNEL_IDS[i],
# CHANNEL_KINDS[i] (dm|channel), and CHANNEL_RECIPIENTS[i] (raw recipient id).
declare -a CHANNEL_NAMES=()
declare -a CHANNEL_IDS=()
declare -a CHANNEL_KINDS=()
declare -a CHANNEL_RECIPIENTS=()
declare -a REMOVE_CHANNELS=()

usage() {
    sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    cat <<'EOF'

Examples:
  # DM the owner: the character can send a direct message to your Discord user id.
  ./scripts/link-character.sh --character "Frog" --agent frog \
    --owner "discord:1509676499979079794" \
    --channel dm --channel-id discord --channel-kind dm --channel-recipient 1509676499979079794

  # Post to a channel ("The Pond"): the character can post into a Discord channel.
  ./scripts/link-character.sh --character "Frog" --agent frog \
    --channel the-pond --channel-id discord --channel-kind channel --channel-recipient 1122334455667788

  # Both at once (repeat the --channel group):
  ./scripts/link-character.sh --character "Frog" --agent frog \
    --channel dm       --channel-id discord --channel-kind dm      --channel-recipient 1509676499979079794 \
    --channel the-pond --channel-id discord --channel-kind channel --channel-recipient 1122334455667788

Finding Discord ids: enable Settings → Advanced → Developer Mode, then right-click a
user or channel → "Copy ID". The user id is for --channel-kind dm; the channel id is for
--channel-kind channel.
EOF
}

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
        --heartbeat-kind)        HEARTBEAT_KIND="$2"; shift 2 ;;
        --heartbeat-account)     HEARTBEAT_ACCOUNT="$2"; shift 2 ;;
        --disable-heartbeat)     DISABLE_HEARTBEAT=true; shift ;;
        --channel)           CHANNEL_NAMES+=("$2"); CHANNEL_IDS+=(""); CHANNEL_KINDS+=(""); CHANNEL_RECIPIENTS+=(""); shift 2 ;;
        --channel-id)        CHANNEL_IDS[${#CHANNEL_IDS[@]}-1]="$2"; shift 2 ;;
        --channel-kind)      CHANNEL_KINDS[${#CHANNEL_KINDS[@]}-1]="$2"; shift 2 ;;
        --channel-recipient) CHANNEL_RECIPIENTS[${#CHANNEL_RECIPIENTS[@]}-1]="$2"; shift 2 ;;
        --remove-channel)    REMOVE_CHANNELS+=("$2"); shift 2 ;;
        --help|-h)   usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; echo "Run with --help for usage." >&2; exit 1 ;;
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

# ─── CSRF state ────────────────────────────────────────────────────────────────
# ST has CSRF protection enabled by default. Fetch the token once via the
# CSRF-exempt GET endpoint and pass it + the session cookie on every POST/DELETE.
# When CSRF is disabled, ST returns {"token":"disabled"} and no cookie; the
# header is still included but ignored by the server.

_csrf_cookie_jar="$(mktemp)"
trap 'rm -f "${_csrf_cookie_jar}"' EXIT

_csrf_token=""
_csrf_resp=$(curl -sS -c "${_csrf_cookie_jar}" -w "\n%{http_code}" \
    "${PLUGIN_URL}/csrf-token" 2>/dev/null) || true
_csrf_http="${_csrf_resp##*$'\n'}"
_csrf_body="${_csrf_resp%$'\n'*}"
if [[ "${_csrf_http}" -ge 200 && "${_csrf_http}" -lt 300 ]]; then
    _csrf_token=$(python3 -c \
        "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('token',''))" \
        <<< "${_csrf_body}" 2>/dev/null) || true
fi

# Wrapper: curl with CSRF session cookie + token header.
_st_curl() {
    curl -sS -b "${_csrf_cookie_jar}" -H "x-csrf-token: ${_csrf_token}" "$@"
}

# ─── URL-encode character name ────────────────────────────────────────────────

# URL-encode the character name (spaces → %20, etc.)
encoded_name="$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "${CHARACTER}" 2>/dev/null \
    || printf '%s' "${CHARACTER}" | sed 's/ /%20/g; s/&/%26/g; s/?/%3F/g')"

endpoint="${PLUGIN_URL}/api/plugins/openclaw-bridge/characters/${encoded_name}/link"

if [[ "${UNLINK}" == true ]]; then
    echo "Removing link for '${CHARACTER}'..."
    _st_curl -X DELETE "${endpoint}" \
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
if [[ "${DISABLE_HEARTBEAT}" == false && -n "${HEARTBEAT_CHANNEL}${HEARTBEAT_INTERVAL_MS}${HEARTBEAT_IDLE_MS}${HEARTBEAT_PROMPT}${HEARTBEAT_TARGET}${HEARTBEAT_KIND}${HEARTBEAT_ACCOUNT}" ]]; then
    if [[ -z "${HEARTBEAT_CHANNEL}" ]]; then
        echo "Error: --heartbeat-channel is required when configuring heartbeat" >&2
        exit 1
    fi
fi

# Validate channel flag pairing: every --channel needs --channel-id, --channel-kind, --channel-recipient
for i in "${!CHANNEL_NAMES[@]}"; do
    if [[ -z "${CHANNEL_IDS[$i]}" ]]; then
        echo "Error: --channel '${CHANNEL_NAMES[$i]}' requires a matching --channel-id (the OC channel/adapter id, e.g. discord)" >&2
        exit 1
    fi
    if [[ "${CHANNEL_KINDS[$i]}" != "dm" && "${CHANNEL_KINDS[$i]}" != "channel" ]]; then
        echo "Error: --channel '${CHANNEL_NAMES[$i]}' requires --channel-kind of 'dm' or 'channel'" >&2
        exit 1
    fi
    if [[ -z "${CHANNEL_RECIPIENTS[$i]}" ]]; then
        echo "Error: --channel '${CHANNEL_NAMES[$i]}' requires --channel-recipient (your user id for dm, the channel id for channel)" >&2
        exit 1
    fi
done

# Validate heartbeat kind if supplied
if [[ -n "${HEARTBEAT_KIND}" && "${HEARTBEAT_KIND}" != "dm" && "${HEARTBEAT_KIND}" != "channel" ]]; then
    echo "Error: --heartbeat-kind must be 'dm' or 'channel'" >&2
    exit 1
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
      -n "${HEARTBEAT_KIND}" || -n "${HEARTBEAT_ACCOUNT}" ]]; then
    HEARTBEAT_GIVEN=true
fi

# Determine if any channel flags were passed
CHANNELS_GIVEN=false
if [[ ${#CHANNEL_NAMES[@]} -gt 0 || ${#REMOVE_CHANNELS[@]} -gt 0 ]]; then
    CHANNELS_GIVEN=true
fi

# If channel mutations requested, GET current channels first then merge client-side
CHANNELS_JSON_CURRENT="[]"
if [[ "${CHANNELS_GIVEN}" == true ]]; then
    get_resp=$(_st_curl -w "\n%{http_code}" "${endpoint}" \
        -H "Authorization: Bearer ${TOKEN}" 2>/dev/null) || true
    get_http="${get_resp##*$'\n'}"
    get_body="${get_resp%$'\n'*}"
    if [[ "${get_http}" -ge 200 && "${get_http}" -lt 300 ]]; then
        CHANNELS_JSON_CURRENT=$(python3 -c \
            "import json,sys; d=json.loads(sys.stdin.read()); print(json.dumps(d.get('link',{}).get('channels',[])))" \
            <<< "${get_body}" 2>/dev/null) || CHANNELS_JSON_CURRENT="[]"
    fi
    # 404 = no link yet; start with an empty channel list
fi

# Build the channel add/remove lists as JSON for the Python builder
channel_adds_json=$(python3 -c "
import json, sys
names      = json.loads(sys.argv[1])
ids        = json.loads(sys.argv[2])
kinds      = json.loads(sys.argv[3])
recipients = json.loads(sys.argv[4])
entries = []
for i, name in enumerate(names):
    entries.append({'name': name, 'channel_id': ids[i], 'kind': kinds[i], 'id': recipients[i]})
print(json.dumps(entries))
" \
    "$(python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" "${CHANNEL_NAMES[@]+"${CHANNEL_NAMES[@]}"}")" \
    "$(python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" "${CHANNEL_IDS[@]+"${CHANNEL_IDS[@]}"}")" \
    "$(python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" "${CHANNEL_KINDS[@]+"${CHANNEL_KINDS[@]}"}")" \
    "$(python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" "${CHANNEL_RECIPIENTS[@]+"${CHANNEL_RECIPIENTS[@]}"}")" \
2>/dev/null) || channel_adds_json="[]"

channel_removes_json=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" \
    "${REMOVE_CHANNELS[@]+"${REMOVE_CHANNELS[@]}"}" 2>/dev/null) || channel_removes_json="[]"

# Use python3 to safely build the full request body
body=$(python3 -c "
import json, sys

agent_id       = sys.argv[1]
owners         = json.loads(sys.argv[2])
hb_disable     = sys.argv[3] == 'true'
hb_given       = sys.argv[4] == 'true'
hb_channel     = sys.argv[5]
hb_interval    = sys.argv[6]
hb_idle        = sys.argv[7]
hb_prompt      = sys.argv[8]
hb_target      = sys.argv[9]
hb_account     = sys.argv[10]
ch_given       = sys.argv[11] == 'true'
ch_current     = json.loads(sys.argv[12])
ch_adds        = json.loads(sys.argv[13])
ch_removes     = json.loads(sys.argv[14])
hb_kind        = sys.argv[15] if len(sys.argv) > 15 else ''

data = {'oc_agent_id': agent_id, 'owner_user_ids': owners}

if hb_given:
    if hb_disable:
        data['heartbeat'] = None
    else:
        hb = {'enabled': True, 'channel_id': hb_channel}
        if hb_interval: hb['interval_ms'] = int(hb_interval)
        if hb_idle:     hb['idle_threshold_ms'] = int(hb_idle)
        if hb_prompt:   hb['prompt'] = hb_prompt
        if hb_target:   hb['target'] = hb_target
        if hb_kind:     hb['kind'] = hb_kind
        if hb_account:  hb['account_id'] = hb_account
        data['heartbeat'] = hb

if ch_given:
    # Start from current channels, upsert adds by name, then remove by name
    by_name = {ch['name']: ch for ch in (ch_current or [])}
    for entry in ch_adds:
        by_name[entry['name']] = entry
    for name in ch_removes:
        by_name.pop(name, None)
    data['channels'] = list(by_name.values())

print(json.dumps(data))
" \
    "${AGENT_ID}" \
    "${owner_json}" \
    "${DISABLE_HEARTBEAT}" \
    "${HEARTBEAT_GIVEN}" \
    "${HEARTBEAT_CHANNEL}" \
    "${HEARTBEAT_INTERVAL_MS}" \
    "${HEARTBEAT_IDLE_MS}" \
    "${HEARTBEAT_PROMPT}" \
    "${HEARTBEAT_TARGET}" \
    "${HEARTBEAT_ACCOUNT}" \
    "${CHANNELS_GIVEN}" \
    "${CHANNELS_JSON_CURRENT}" \
    "${channel_adds_json}" \
    "${channel_removes_json}" \
    "${HEARTBEAT_KIND}")

echo "Linking '${CHARACTER}' → agent '${AGENT_ID}'..."
if [[ ${#OWNER_IDS[@]} -gt 0 ]]; then
    echo "Owners: ${OWNER_IDS[*]}"
fi
if [[ "${DISABLE_HEARTBEAT}" == true ]]; then
    echo "Heartbeat: disabling"
elif [[ -n "${HEARTBEAT_CHANNEL}" ]]; then
    echo "Heartbeat: enabled on channel '${HEARTBEAT_CHANNEL}'"
fi
if [[ ${#CHANNEL_NAMES[@]} -gt 0 ]]; then
    echo "Channels: adding/updating ${CHANNEL_NAMES[*]}"
fi
if [[ ${#REMOVE_CHANNELS[@]} -gt 0 ]]; then
    echo "Channels: removing ${REMOVE_CHANNELS[*]}"
fi
echo

response=$(_st_curl -w "\n%{http_code}" -X POST "${endpoint}" \
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
