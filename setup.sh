#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "openclaw-bridge setup"
echo "=============================="
echo

# ─── Prerequisites ────────────────────────────────────────────────────────────

if command -v node >/dev/null 2>&1; then
    node_ver=$(node -v | sed 's/^v//')
    node_major="${node_ver%%.*}"
    if [ "${node_major}" -lt 22 ]; then
        echo "Warning: Node.js ${node_ver} detected — Node 22+ is recommended."
    else
        echo "Node.js ${node_ver} OK"
    fi
else
    echo "Warning: node not found in PATH. Install Node.js 22+ before proceeding."
fi

if command -v openclaw >/dev/null 2>&1; then
    echo "openclaw CLI found: $(openclaw --version 2>/dev/null || echo '(version unknown)')"
else
    echo "Warning: openclaw CLI not found — install OpenClaw before running agents."
fi

if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
        echo "Docker available"
    else
        echo "Warning: Docker present but not responding — it may be stopped."
    fi
else
    echo "Warning: docker not found. Install Docker if you need containerised services."
fi

if command -v curl >/dev/null 2>&1; then
    if curl -sS --max-time 3 http://localhost:18789/health >/dev/null 2>&1; then
        echo "OpenClaw health OK"
    else
        echo "Note: OpenClaw not reachable yet — this is normal if you haven't started it."
    fi
fi

echo

# ─── npm dependencies (must run before copying plugin into ST) ────────────────

if [ -d "${script_dir}/st-plugin" ]; then
    echo "Installing plugin dependencies..."
    (cd "${script_dir}/st-plugin" && npm install --no-audit --no-fund --quiet)
    echo "Done."
fi

echo

# ─── Helpers ──────────────────────────────────────────────────────────────────

# Returns 0 if the directory looks like a SillyTavern installation.
is_st_dir() {
    local dir="$1"
    [[ -d "${dir}" && -d "${dir}/plugins" && -d "${dir}/public/scripts/extensions" ]]
}

# Copy (or update) the plugin and extension into a ST directory.
install_into_st() {
    local st_path="$1"
    local plugin_dst="${st_path}/plugins/openclaw-bridge"
    local ext_dst="${st_path}/public/scripts/extensions/openclaw-bridge"

    mkdir -p "${plugin_dst}" "${ext_dst}"
    cp -r "${script_dir}/st-plugin/."    "${plugin_dst}/"
    cp -r "${script_dir}/st-extension/." "${ext_dst}/"

    echo "  Plugin:    ${plugin_dst}"
    echo "  Extension: ${ext_dst}"
    echo
    echo "  Restart SillyTavern, then refresh your browser tab to activate the extension."
}

# ─── Locate SillyTavern and install plugin + extension ────────────────────────

echo "--- SillyTavern plugin + extension ---"
echo

if [[ -d "${script_dir}/sillytavern" ]]; then
    # Developer checkout: ST is a submodule in the repo — use symlinks so edits
    # to the source are reflected immediately without re-running setup.
    echo "Developer mode: SillyTavern submodule detected — installing as symlinks."
    bash "${script_dir}/dev-setup.sh"
else
    # End-user mode: find ST, confirm, and copy.

    st_found=()
    for candidate in \
        "$HOME/SillyTavern" \
        "$HOME/sillytavern" \
        "$HOME/Documents/SillyTavern" \
        "$HOME/Downloads/SillyTavern" \
        "$HOME/Desktop/SillyTavern" \
        "/opt/SillyTavern" \
        "/opt/sillytavern"; do
        if is_st_dir "${candidate}"; then
            st_found+=("${candidate}")
        fi
    done

    ST_PATH=""

    if [[ ${#st_found[@]} -eq 0 ]]; then
        echo "Could not find SillyTavern in common locations."
        if [[ -t 0 ]]; then
            read -r -p "Enter the path to your SillyTavern installation: " ST_PATH || ST_PATH=""
            ST_PATH="${ST_PATH/#\~/$HOME}"
        fi

    elif [[ ${#st_found[@]} -eq 1 ]]; then
        echo "Found SillyTavern at: ${st_found[0]}"
        _answer=""
        if [[ -t 0 ]]; then
            read -r -p "Install plugin and extension here? [Y/n] " _answer || _answer=""
        fi
        case "${_answer}" in
            [nN]*)
                if [[ -t 0 ]]; then
                    read -r -p "Enter the path to your SillyTavern installation: " ST_PATH || ST_PATH=""
                    ST_PATH="${ST_PATH/#\~/$HOME}"
                fi
                ;;
            *) ST_PATH="${st_found[0]}" ;;
        esac

    else
        echo "Found multiple SillyTavern installations:"
        for i in "${!st_found[@]}"; do
            if [[ $i -eq 0 ]]; then
                echo "  $((i+1)). ${st_found[$i]}  (default)"
            else
                echo "  $((i+1)). ${st_found[$i]}"
            fi
        done
        echo
        _sel="1"
        if [[ -t 0 ]]; then
            read -r -p "Select installation [1]: " _sel || _sel="1"
            _sel="${_sel:-1}"
        fi
        if [[ "${_sel}" =~ ^[0-9]+$ ]] && (( _sel >= 1 && _sel <= ${#st_found[@]} )); then
            ST_PATH="${st_found[$((_sel-1))]}"
        else
            # treat non-numeric input as a custom path
            ST_PATH="${_sel/#\~/$HOME}"
        fi
    fi

    if [[ -z "${ST_PATH}" ]]; then
        echo
        echo "No path provided — skipping plugin installation."
        echo "Install manually after setup:"
        echo "  cp -r '${script_dir}/st-plugin'    /path/to/SillyTavern/plugins/openclaw-bridge"
        echo "  cp -r '${script_dir}/st-extension' /path/to/SillyTavern/public/scripts/extensions/openclaw-bridge"
    elif ! is_st_dir "${ST_PATH}"; then
        echo
        echo "Warning: '${ST_PATH}' does not look like a SillyTavern installation."
        echo "(Expected to find plugins/ and public/scripts/extensions/ inside it.)"
        _ans=""
        if [[ -t 0 ]]; then
            read -r -p "Install there anyway? [y/N] " _ans || _ans=""
        fi
        case "${_ans}" in
            [yY]*)
                mkdir -p "${ST_PATH}/plugins" "${ST_PATH}/public/scripts/extensions"
                install_into_st "${ST_PATH}"
                ;;
            *)
                echo "Skipping plugin installation."
                echo "Install manually after setup:"
                echo "  cp -r '${script_dir}/st-plugin'    ${ST_PATH}/plugins/openclaw-bridge"
                echo "  cp -r '${script_dir}/st-extension' ${ST_PATH}/public/scripts/extensions/openclaw-bridge"
                ;;
        esac
    else
        install_into_st "${ST_PATH}"
    fi
fi

echo

# ─── Bridge auth token ────────────────────────────────────────────────────────

token_dir="${script_dir}/data/openclaw-bridge"
token_file="${token_dir}/bridge-token.txt"
mkdir -p "${token_dir}"

if [ ! -f "${token_file}" ]; then
    if command -v openssl >/dev/null 2>&1; then
        token=$(openssl rand -hex 32)
    else
        token=$(head -c 24 /dev/urandom | base64 | tr -d '\n')
    fi
    printf '%s' "${token}" > "${token_file}"
    echo "Generated bridge auth token: ${token_file}"
else
    echo "Bridge token already exists: ${token_file}"
fi

# ─── Shared data symlinks for the OC gateway plugin ──────────────────────────

oc_data_dir="${HOME}/.openclaw/openclaw-bridge"
mkdir -p "${oc_data_dir}"

links_file="${token_dir}/character-links.json"
if [ ! -f "${links_file}" ]; then
    printf '{}' > "${links_file}"
    echo "Created character-links.json"
fi

for fname in bridge-token.txt character-links.json; do
    src="${token_dir}/${fname}"
    dst="${oc_data_dir}/${fname}"
    if [ ! -e "${dst}" ] && [ ! -L "${dst}" ]; then
        ln -s "${src}" "${dst}"
        echo "Linked ${dst}"
    fi
done

# ─── OC gateway plugin ────────────────────────────────────────────────────────

echo
if command -v openclaw >/dev/null 2>&1; then
    echo "Installing OC gateway plugin..."
    openclaw plugins install --path "${script_dir}/oc-plugin" 2>&1 || \
        echo "Warning: OC plugin install failed — run 'openclaw plugins install --path ${script_dir}/oc-plugin' manually."
else
    echo "Note: openclaw CLI not found — install the OC gateway plugin manually after starting the gateway:"
    echo "  openclaw plugins install --path ${script_dir}/oc-plugin"
fi

# ─── Next steps ───────────────────────────────────────────────────────────────

echo
echo "=============================="
echo "Setup complete."
echo
echo "Next steps:"
echo "  1. Restart SillyTavern (picks up the plugin) and refresh your browser tab."
echo "  2. Link each character to an OC agent:"
echo "       ./scripts/link-character.sh --character \"My Character\" --agent my-agent --owner \"discord:YOUR_USER_ID\""
echo "  3. Follow AGENT-SETUP.md to create the OC agent and bind it to a channel."
echo "  4. Restart the OpenClaw gateway:"
echo "       openclaw gateway restart"
echo
echo "Bridge token (needed for OPENCLAW_BRIDGE_TOKEN in openclaw.json):"
echo "  $(cat "${token_file}")"
echo
