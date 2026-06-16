#!/usr/bin/env bash
# uninstall.sh — Remove openclaw-bridge from SillyTavern and OpenClaw
#
# Usage:
#   ./uninstall.sh [options]
#
# Options:
#   --st-path PATH   Path to your SillyTavern installation (skips auto-discovery
#                    and all interactive prompts; safe for agent/CI use)
#   --yes            Auto-confirm all prompts (uses the first auto-detected ST
#                    installation without asking; ignored if --st-path is set)
#   --delete-data    Also remove data/openclaw-bridge/ (bridge token and
#                    character-links.json); default is to keep it so a
#                    re-install picks up where you left off
#   --skip-st        Skip plugin/extension removal from SillyTavern
#   --help           Show this help
#
# Non-interactive example (agent or CI):
#   ./uninstall.sh --st-path ~/SillyTavern --yes
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Argument parsing ─────────────────────────────────────────────────────────

ARG_ST_PATH=""
ARG_YES=false
ARG_DELETE_DATA=false
ARG_SKIP_ST=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --st-path)     ARG_ST_PATH="${2:-}"; ARG_ST_PATH="${ARG_ST_PATH/#\~/$HOME}"; shift 2 ;;
        --yes|-y)      ARG_YES=true; shift ;;
        --delete-data) ARG_DELETE_DATA=true; shift ;;
        --skip-st)     ARG_SKIP_ST=true; shift ;;
        --help|-h)
            awk 'NR>1 && /^set -/{exit} NR>1{sub(/^# ?/, ""); print}' "$0"
            exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

echo "openclaw-bridge uninstall"
echo "=============================="
echo

removed=()
skipped=()

# ─── Helpers ──────────────────────────────────────────────────────────────────

remove_dir() {
    local path="$1" label="$2"
    if [ -L "${path}" ]; then
        rm "${path}"
        echo "  Removed symlink: ${path}"
        removed+=("${label}")
    elif [ -d "${path}" ]; then
        rm -rf "${path}"
        echo "  Removed: ${path}"
        removed+=("${label}")
    else
        echo "  Not found (skipping): ${path}"
        skipped+=("${label}")
    fi
}

remove_symlink() {
    local path="$1" label="$2"
    if [ -L "${path}" ]; then
        rm "${path}"
        echo "  Removed symlink: ${path}"
        removed+=("${label}")
    elif [ -e "${path}" ]; then
        echo "  Not a symlink — leaving untouched: ${path}"
        skipped+=("${label}")
    else
        echo "  Not found (skipping): ${path}"
    fi
}

# Returns 0 if the directory looks like a SillyTavern installation.
is_st_dir() {
    local dir="$1"
    [[ -d "${dir}" && -d "${dir}/plugins" && -d "${dir}/public/scripts/extensions" ]]
}

# ─── SillyTavern plugin + extension removal ───────────────────────────────────

echo "--- SillyTavern plugin + extension ---"
echo

if [[ "${ARG_SKIP_ST}" == true ]]; then
    echo "Skipping ST removal (--skip-st)."

elif [[ -n "${ARG_ST_PATH}" ]]; then
    echo "Using provided path: ${ARG_ST_PATH}"
    remove_dir "${ARG_ST_PATH}/plugins/openclaw-bridge"          "ST plugin"
    remove_dir "${ARG_ST_PATH}/public/scripts/extensions/openclaw-bridge" "ST extension"

elif [[ -d "${script_dir}/sillytavern" ]]; then
    # Developer checkout — setup.sh installed symlinks, not copies.
    echo "Developer mode: removing symlinks."
    remove_dir "${script_dir}/sillytavern/plugins/openclaw-bridge" "ST plugin symlink"
    remove_dir "${script_dir}/sillytavern/public/scripts/extensions/openclaw-bridge" "ST extension symlink"

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
            read -r -p "Enter the path to your SillyTavern installation (or press Enter to skip): " ST_PATH || ST_PATH=""
            ST_PATH="${ST_PATH/#\~/$HOME}"
        fi

    elif [[ ${#st_found[@]} -eq 1 ]]; then
        echo "Found SillyTavern at: ${st_found[0]}"
        if [[ "${ARG_YES}" == true ]]; then
            ST_PATH="${st_found[0]}"
        elif [[ -t 0 ]]; then
            _answer=""
            read -r -p "Remove plugin and extension from here? [Y/n] " _answer || _answer=""
            case "${_answer}" in
                [nN]*) ;;
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
        echo "No path provided — skipping ST removal."
        echo "Re-run with --st-path to remove non-interactively, or remove manually:"
        echo "  rm -rf '/path/to/SillyTavern/plugins/openclaw-bridge'"
        echo "  rm -rf '/path/to/SillyTavern/public/scripts/extensions/openclaw-bridge'"
        skipped+=("ST plugin" "ST extension")
    else
        remove_dir "${ST_PATH}/plugins/openclaw-bridge"          "ST plugin"
        remove_dir "${ST_PATH}/public/scripts/extensions/openclaw-bridge" "ST extension"
    fi
fi

echo

# ─── OC gateway plugin ────────────────────────────────────────────────────────

echo "--- OpenClaw plugin ---"
echo

if command -v openclaw >/dev/null 2>&1; then
    echo "Uninstalling OC gateway plugin..."
    if openclaw plugins uninstall openclaw-bridge 2>&1; then
        echo "  OC plugin removed."
        removed+=("OC plugin")
    else
        echo "  Note: OC plugin may not have been installed — skipping."
        skipped+=("OC plugin")
    fi
else
    echo "Note: openclaw CLI not found — skipping OC plugin removal."
    echo "If the plugin is installed, run 'openclaw plugins uninstall openclaw-bridge' manually."
    skipped+=("OC plugin")
fi

echo

# ─── Shared data symlinks ─────────────────────────────────────────────────────

echo "--- OC data symlinks (~/.openclaw/openclaw-bridge/) ---"
echo

oc_data_dir="${HOME}/.openclaw/openclaw-bridge"
for fname in bridge-token.txt character-links.json; do
    remove_symlink "${oc_data_dir}/${fname}" "OC data symlink: ${fname}"
done

# Remove the OC data directory if it is now empty.
if [ -d "${oc_data_dir}" ] && [ -z "$(ls -A "${oc_data_dir}" 2>/dev/null)" ]; then
    rmdir "${oc_data_dir}"
    echo "  Removed empty directory: ${oc_data_dir}"
fi

echo

# ─── Bridge data directory ────────────────────────────────────────────────────

echo "--- Bridge data (data/openclaw-bridge/) ---"
echo

data_dir="${script_dir}/data/openclaw-bridge"

if [ -d "${data_dir}" ]; then
    do_delete=false
    if [[ "${ARG_DELETE_DATA}" == true ]]; then
        do_delete=true
    elif [[ "${ARG_YES}" == false && -t 0 ]]; then
        echo "Found: ${data_dir}"
        echo "(Contains bridge token and character-links.json — keeping it lets you"
        echo " re-install cleanly later without regenerating the token.)"
        _ans=""
        read -r -p "Delete bridge data? [y/N] " _ans || _ans=""
        case "${_ans}" in
            [yY]*) do_delete=true ;;
            *) ;;
        esac
    fi

    if [[ "${do_delete}" == true ]]; then
        rm -rf "${data_dir}"
        echo "  Removed: ${data_dir}"
        removed+=("Bridge data")
    else
        echo "  Kept: ${data_dir}"
        echo "  (Pass --delete-data to remove it.)"
        skipped+=("Bridge data (kept by default)")
    fi
else
    echo "  Not found (skipping): ${data_dir}"
fi

echo

# ─── Summary ──────────────────────────────────────────────────────────────────

echo "=============================="
echo "Uninstall complete."
echo

if [[ ${#removed[@]} -gt 0 ]]; then
    echo "Removed:"
    for item in "${removed[@]}"; do
        echo "  - ${item}"
    done
    echo
fi

if [[ ${#skipped[@]} -gt 0 ]]; then
    echo "Kept / not found:"
    for item in "${skipped[@]}"; do
        echo "  - ${item}"
    done
    echo
fi

echo "Restart SillyTavern to deactivate the plugin and extension."
echo
