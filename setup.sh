#!/usr/bin/env bash
# setup.sh — one-time bootstrap for openclaw-bridge
#
# Usage:
#   ./setup.sh [options]
#
# Options:
#   --st-path PATH   Path to your SillyTavern installation (skips auto-discovery
#                    and all interactive prompts; safe for agent/CI use)
#   --yes            Auto-confirm all prompts (uses the first auto-detected ST
#                    installation without asking; ignored if --st-path is set)
#   --skip-st        Skip plugin/extension installation entirely
#   --help           Show this help
#
# Non-interactive example (agent or CI):
#   ./setup.sh --st-path ~/SillyTavern
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Argument parsing ─────────────────────────────────────────────────────────

ARG_ST_PATH=""
ARG_YES=false
ARG_SKIP_ST=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --st-path)  ARG_ST_PATH="${2:-}"; ARG_ST_PATH="${ARG_ST_PATH/#\~/$HOME}"; shift 2 ;;
        --yes|-y)   ARG_YES=true; shift ;;
        --skip-st)  ARG_SKIP_ST=true; shift ;;
        --help|-h)
            awk 'NR>1 && /^set -/{exit} NR>1{sub(/^# ?/, ""); print}' "$0"
            exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

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

if command -v python3 >/dev/null 2>&1; then
    echo "python3 $(python3 --version 2>&1 | awk '{print $2}') OK"
else
    echo "Error: python3 not found in PATH. Install python3 before proceeding." >&2
    exit 1
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
    # The headless generation service requires Playwright's chromium binary, which
    # the npm package alone does not provide. Without it, getClient() finds no
    # headless client and OC->ST messages are never generated. Skip the download when
    # a system Chromium is already provided (CHROMIUM_EXECUTABLE_PATH) or when it is
    # explicitly disabled. Non-fatal: a clean install should still complete (with a
    # clear hint) if the download fails.
    if [ -n "${CHROMIUM_EXECUTABLE_PATH:-}" ]; then
        echo "Using system Chromium at ${CHROMIUM_EXECUTABLE_PATH} — skipping Playwright browser download."
    elif [ "${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-}" = "1" ]; then
        echo "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 — skipping Playwright browser download."
    else
        echo "Installing Playwright chromium for the headless service..."
        (cd "${script_dir}/st-plugin" && npx --yes playwright install chromium) || \
            echo "Warning: 'playwright install chromium' failed — run it manually in the installed plugin dir, or the headless service stays disabled."
    fi
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

    local shared_dst="${st_path}/plugins/shared"

    mkdir -p "${plugin_dst}" "${ext_dst}" "${shared_dst}"
    cp -r "${script_dir}/shared/."       "${shared_dst}/"
    cp -r "${script_dir}/st-plugin/."    "${plugin_dst}/"
    cp -r "${script_dir}/st-extension/." "${ext_dst}/"

    echo "  Plugin:    ${plugin_dst}"
    echo "  Extension: ${ext_dst}"
    echo
    echo "  Restart SillyTavern, then refresh your browser tab to activate the extension."

    # Persist the resolved ST path so update.sh can re-use it without prompting.
    local config_dir="${script_dir}/data/openclaw-bridge"
    mkdir -p "${config_dir}"
    printf 'st_path=%q\n' "${st_path}" > "${config_dir}/config"
}

# ─── Locate SillyTavern and install plugin + extension ────────────────────────

echo "--- SillyTavern plugin + extension ---"
echo

if [[ "${ARG_SKIP_ST}" == true ]]; then
    echo "Skipping ST installation (--skip-st)."

elif [[ -n "${ARG_ST_PATH}" ]]; then
    # Non-interactive: path supplied via --st-path; install directly.
    echo "Using provided path: ${ARG_ST_PATH}"
    if ! is_st_dir "${ARG_ST_PATH}"; then
        echo "Warning: '${ARG_ST_PATH}' does not look like a SillyTavern installation."
        echo "(Expected to find plugins/ and public/scripts/extensions/ inside it.)"
        echo "Installing anyway as --st-path was explicit."
        mkdir -p "${ARG_ST_PATH}/plugins" "${ARG_ST_PATH}/public/scripts/extensions"
    fi
    install_into_st "${ARG_ST_PATH}"

elif [[ -d "${script_dir}/sillytavern" ]]; then
    # Developer checkout: ST is a submodule in the repo — use symlinks so edits
    # to the source are reflected immediately without re-running setup.
    echo "Developer mode: SillyTavern submodule detected — installing as symlinks."
    bash "${script_dir}/dev-setup.sh"
    mkdir -p "${script_dir}/data/openclaw-bridge"
    printf 'st_path=%q\n' "${script_dir}/sillytavern" > "${script_dir}/data/openclaw-bridge/config"

else
    # Interactive mode: auto-discover, then confirm or prompt.

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
        if [[ "${ARG_YES}" == true ]]; then
            ST_PATH="${st_found[0]}"
        elif [[ -t 0 ]]; then
            _answer=""
            read -r -p "Install plugin and extension here? [Y/n] " _answer || _answer=""
            case "${_answer}" in
                [nN]*)
                    read -r -p "Enter the path to your SillyTavern installation: " ST_PATH || ST_PATH=""
                    ST_PATH="${ST_PATH/#\~/$HOME}"
                    ;;
                *) ST_PATH="${st_found[0]}" ;;
            esac
        fi

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
        if [[ "${ARG_YES}" == true ]]; then
            ST_PATH="${st_found[0]}"
            echo "Using default: ${ST_PATH}"
        elif [[ -t 0 ]]; then
            _sel=""
            read -r -p "Select installation [1]: " _sel || _sel=""
            _sel="${_sel:-1}"
            if [[ "${_sel}" =~ ^[0-9]+$ ]] && (( _sel >= 1 && _sel <= ${#st_found[@]} )); then
                ST_PATH="${st_found[$((_sel-1))]}"
            else
                ST_PATH="${_sel/#\~/$HOME}"
            fi
        fi
    fi

    if [[ -z "${ST_PATH}" ]]; then
        echo
        echo "No path provided — skipping plugin installation."
        echo "Re-run with --st-path to install non-interactively, or install manually:"
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
                echo "Re-run with --st-path to install non-interactively, or install manually:"
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

schema_version_file="${token_dir}/schema-version.txt"
if [ ! -f "${schema_version_file}" ]; then
    printf '1' > "${schema_version_file}"
    echo "Initialized schema version: ${schema_version_file}"
fi

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
    # OC 2026.5.27 takes the path as a positional argument; --link mirrors the dev
    # symlink so oc-plugin/ edits are picked up without re-installing.
    openclaw plugins install --link "${script_dir}/oc-plugin" 2>&1 || \
        echo "Warning: OC plugin install failed — run 'openclaw plugins install --link ${script_dir}/oc-plugin' manually."
else
    echo "Note: openclaw CLI not found — install the OC gateway plugin manually after starting the gateway:"
    echo "  openclaw plugins install --link ${script_dir}/oc-plugin"
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
echo "  3. Create your OC agent and bind it to a channel (per your OpenClaw setup),"
echo "     then see docs/getting-started.md and docs/adding-a-character.md."
echo "  4. Restart the OpenClaw gateway:"
echo "       openclaw gateway restart"
echo
echo "Bridge token (auto-loaded by the OC plugin from the linked data dir; set"
echo "OPENCLAW_BRIDGE_TOKEN in openclaw.json only if you relocate that data dir):"
echo "  $(cat "${token_file}")"
echo
