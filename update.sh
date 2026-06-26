#!/usr/bin/env bash
# update.sh — pull the latest openclaw-bridge release and redeploy
#
# Usage:
#   ./update.sh [options]
#
# Options:
#   --st-path PATH   Path to your SillyTavern installation (overrides saved config;
#                    safe for agent/CI use)
#   --yes            Auto-confirm all prompts (uses first auto-detected ST install)
#   --skip-st        Skip ST plugin + extension update
#   --skip-oc        Skip OC plugin recompile and dist copy
#   --skip-pull      Skip git pull, dirty-tree check, and self-re-exec
#                    (used by E2E tests; also useful after a manual git checkout)
#   --help           Show this help
#
# Non-interactive example:
#   ./update.sh --st-path ~/SillyTavern
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
data_dir="${script_dir}/data/openclaw-bridge"

# ─── Deletion-aware tree mirror ───────────────────────────────────────────────
# Converge an install directory to match a source tree, the same end-state a
# fresh install produces (update == reinstall). Unlike `cp -r src/. dst/`, this
# removes files that no longer exist upstream (orphans) instead of letting them
# linger. The caller is responsible for the dev-symlink guard — never call this
# on a `[ -L ]` symlink target or it would replace a live dev checkout.
#
#   mirror_tree SRC DST MODE
#     MODE=full        mirror everything, including node_modules
#     MODE=no-modules  mirror everything EXCEPT node_modules, and preserve any
#                      node_modules already present in DST (the installer owns
#                      it; e.g. OC regenerates it via `npm install` afterwards)
mirror_tree() {
    local src="$1" dst="$2" mode="$3"
    mkdir -p "${dst}"
    if [[ "${mode}" == "full" ]]; then
        # Remove all existing content, then copy the whole source tree.
        find "${dst}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
        cp -r "${src}/." "${dst}/"
    else
        # Remove orphans but keep DST's node_modules, then copy every top-level
        # entry from SRC except node_modules (dotfiles included).
        find "${dst}" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
        (
            shopt -s dotglob
            local entry
            for entry in "${src}"/*; do
                [[ "$(basename "${entry}")" == node_modules ]] && continue
                cp -r "${entry}" "${dst}/"
            done
        )
    fi
}

# ─── Argument parsing ─────────────────────────────────────────────────────────

ARG_ST_PATH=""
ARG_YES=false
ARG_SKIP_ST=false
ARG_SKIP_OC=false
ARG_SKIP_PULL=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --st-path)  ARG_ST_PATH="${2:-}"; ARG_ST_PATH="${ARG_ST_PATH/#\~/$HOME}"; shift 2 ;;
        --yes|-y)   ARG_YES=true; shift ;;
        --skip-st)  ARG_SKIP_ST=true; shift ;;
        --skip-oc)  ARG_SKIP_OC=true; shift ;;
        --skip-pull) ARG_SKIP_PULL=true; shift ;;
        --help|-h)
            awk 'NR>1 && /^set -/{exit} NR>1{sub(/^# ?/, ""); print}' "$0"
            exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

echo "openclaw-bridge update"
echo "=============================="
echo

# ─── Prerequisite checks ──────────────────────────────────────────────────────

if command -v node >/dev/null 2>&1; then
    node_ver=$(node -v | sed 's/^v//')
    node_major="${node_ver%%.*}"
    if [ "${node_major}" -lt 22 ]; then
        echo "Warning: Node.js ${node_ver} detected — Node 22+ is recommended."
    else
        echo "Node.js ${node_ver} OK"
    fi
else
    echo "Error: node not found in PATH. Install Node.js 22+ before updating." >&2
    exit 1
fi

echo

# ─── Dirty-tree check ─────────────────────────────────────────────────────────

if [[ "${ARG_SKIP_PULL}" == false ]]; then
    if ! git -C "${script_dir}" diff --quiet || ! git -C "${script_dir}" diff --cached --quiet; then
        echo "Error: uncommitted local changes detected in ${script_dir}." >&2
        echo >&2
        echo "To stash your changes and continue:" >&2
        echo "  git -C ${script_dir} stash" >&2
        echo >&2
        echo "To discard all local changes (destructive — cannot be undone):" >&2
        echo "  git -C ${script_dir} reset --hard HEAD" >&2
        echo "  git -C ${script_dir} clean -fd" >&2
        exit 1
    fi

    # ─── git pull ─────────────────────────────────────────────────────────────

    echo "Pulling latest changes..."
    prev_head=$(git -C "${script_dir}" rev-parse HEAD)
    if ! git -C "${script_dir}" pull --ff-only 2>&1; then
        echo >&2
        echo "Error: git pull failed. Your branch may have diverged from the remote." >&2
        echo "Check 'git status' and resolve before updating." >&2
        exit 1
    fi
    curr_head=$(git -C "${script_dir}" rev-parse HEAD)

    if [[ "${prev_head}" == "${curr_head}" ]]; then
        echo "Already up to date."
    else
        echo "Updated to $(git -C "${script_dir}" rev-parse --short HEAD)."

        # ─── Self-re-exec if update.sh itself changed ─────────────────────────
        # If the update script was part of this pull, hand off to the new version
        # so the rest of the update runs with the patched script.
        if ! git -C "${script_dir}" diff --quiet "${prev_head}" "${curr_head}" -- update.sh; then
            echo
            echo "update.sh was updated — re-running the new version..."
            exec "${script_dir}/update.sh" "$@"
        fi
    fi
    echo
fi

# ─── npm install ──────────────────────────────────────────────────────────────

echo "Installing/updating npm dependencies..."

if [ -d "${script_dir}/st-plugin" ]; then
    (cd "${script_dir}/st-plugin" && npm install --no-audit --no-fund --quiet)
fi

if [ -d "${script_dir}/oc-plugin" ]; then
    (cd "${script_dir}/oc-plugin" && npm install --no-audit --no-fund --quiet)
fi

echo "Done."
echo

# ─── OC plugin recompile + dist copy ──────────────────────────────────────────

if [[ "${ARG_SKIP_OC}" == false ]]; then
    echo "--- OC gateway plugin ---"
    echo

    tsc_bin="${script_dir}/oc-plugin/node_modules/.bin/tsc"
    if [ ! -x "${tsc_bin}" ]; then
        echo "Warning: tsc not found at ${tsc_bin} — skipping OC recompile and dist copy."
        echo "  This should not happen after a normal update. If it persists, run:"
        echo "    cd ${script_dir}/oc-plugin && npm install"
    else
        echo "Recompiling OC plugin TypeScript..."
        "${tsc_bin}" --project "${script_dir}/oc-plugin/tsconfig.json"
        echo "Done."
    fi

    oc_install_dir="${HOME}/.openclaw/extensions/openclaw-bridge"
    if [ -L "${oc_install_dir}" ]; then
        # Dev checkout: the install dir is a dev-setup.sh symlink back to the repo,
        # so the freshly recompiled dist/ is already live — don't clobber it.
        echo "OC plugin is a dev symlink (${oc_install_dir}) — edits are already live."
        echo "  (Recompiled above; rebuild the committed output with: npm run build:oc-plugin)"
    elif [ -d "${oc_install_dir}" ]; then
        # Mirror the WHOLE plugin tree, the same end-state a fresh
        # `openclaw plugins install --force` produces — so a stale src/ (which
        # OC's security scanner reads), package.json, manifest, or a removed
        # dist file can never linger. node_modules is excluded from the copy and
        # regenerated below: OC has zero runtime deps today (the gateway SDK is
        # host-provided), but running npm here means a future runtime dep lands
        # automatically on update. A plain filesystem mirror needs no openclaw
        # CLI (a copy-installed plugin is just a real dir).
        echo "Updating OC plugin at ${oc_install_dir}..."
        mirror_tree "${script_dir}/oc-plugin" "${oc_install_dir}" no-modules
        (cd "${oc_install_dir}" && npm install --omit=dev --no-audit --no-fund --quiet) \
            || echo "Warning: npm install in ${oc_install_dir} failed (OC has no runtime deps today, so this is non-fatal)."
        echo "Done."
    else
        echo "Note: OC plugin install directory not found at ${oc_install_dir}."
        echo "  If OpenClaw is installed, run: openclaw plugins install --force ${script_dir}/oc-plugin"
    fi

    echo
fi

# ─── Schema migrations ────────────────────────────────────────────────────────

echo "--- Schema migrations ---"
echo

mkdir -p "${data_dir}"

schema_version_file="${data_dir}/schema-version.txt"
if [ -f "${schema_version_file}" ]; then
    current_version=$(tr -d '[:space:]' < "${schema_version_file}")
else
    current_version=0
fi

ran_any=false
for migration in $(find "${script_dir}/migrations" -maxdepth 1 -name '[0-9]*.sh' 2>/dev/null | sort); do
    filename="$(basename "${migration}")"
    # Extract the numeric prefix (e.g. 0001 from 0001_baseline.sh).
    num="${filename%%_*}"
    # Strip leading zeros for arithmetic comparison (use 10# prefix for base-10).
    migration_num=$((10#${num}))
    current_num=$((10#${current_version}))
    if [ "${migration_num}" -gt "${current_num}" ]; then
        echo "Running migration ${num}..."
        bash "${migration}" "${data_dir}"
        printf '%s' "${num}" > "${schema_version_file}"
        ran_any=true
        echo "  Schema version → ${num}"
    fi
done

if [[ "${ran_any}" == false ]]; then
    echo "Schema is up to date (version ${current_version})."
fi

echo

# ─── ST plugin + extension update ─────────────────────────────────────────────

if [[ "${ARG_SKIP_ST}" == false ]]; then
    echo "--- SillyTavern plugin + extension ---"
    echo

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

        # Mirror each tree (deletion-aware) so files removed upstream don't
        # linger as orphans in the install. ST plugins have no installer CLI, so
        # the repo tree is the source of truth — full mode carries st-plugin's
        # real runtime node_modules (playwright, ws), so a new ST runtime dep
        # always lands. Skip any target that is a dev-setup.sh symlink: those
        # point back at the repo, so edits are already live and a mirror would
        # clobber the live checkout.
        mirror_st_target() {
            local src="$1" dst="$2"
            if [ -L "${dst}" ]; then
                echo "  Dev symlink (${dst}) — edits already live, skipping."
                return
            fi
            mirror_tree "${src}" "${dst}" full
        }

        mirror_st_target "${script_dir}/shared"       "${shared_dst}"
        mirror_st_target "${script_dir}/st-plugin"    "${plugin_dst}"
        mirror_st_target "${script_dir}/st-extension" "${ext_dst}"

        echo "  Plugin:    ${plugin_dst}"
        echo "  Extension: ${ext_dst}"

        # Keep saved config current in case --st-path was used.
        mkdir -p "${data_dir}"
        printf 'st_path=%q\n' "${st_path}" > "${data_dir}/config"
    }

    ST_PATH=""

    if [[ -n "${ARG_ST_PATH}" ]]; then
        ST_PATH="${ARG_ST_PATH}"
        echo "Using provided path: ${ST_PATH}"

    elif [ -f "${data_dir}/config" ]; then
        # shellcheck source=/dev/null
        . "${data_dir}/config"
        if [[ -n "${st_path:-}" ]]; then
            ST_PATH="${st_path}"
            echo "Using saved ST path: ${ST_PATH}"
        fi

    else
        # Fall back to auto-discovery (same candidates as setup.sh).
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

        if [[ ${#st_found[@]} -eq 0 ]]; then
            echo "Could not find SillyTavern and no saved path found."
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
                read -r -p "Update plugin and extension here? [Y/n] " _answer || _answer=""
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
    fi

    if [[ -z "${ST_PATH}" ]]; then
        echo
        echo "No ST path found — skipping plugin update."
        echo "Re-run with --st-path to update non-interactively:"
        echo "  ./update.sh --st-path /path/to/SillyTavern"

    elif ! is_st_dir "${ST_PATH}"; then
        echo
        echo "Warning: '${ST_PATH}' does not look like a SillyTavern installation."
        echo "Skipping plugin update. Re-run with a valid --st-path."

    else
        install_into_st "${ST_PATH}"
        echo
        echo "  Restart SillyTavern, then refresh your browser tab to activate the extension."
    fi

    echo
fi

# ─── Restart checklist ────────────────────────────────────────────────────────

echo "=============================="
echo "Update complete."
echo
echo "Restart checklist:"
if [[ "${ARG_SKIP_OC}" == false ]]; then
    echo "  1. Restart the OpenClaw gateway:"
    echo "       openclaw gateway restart"
fi
if [[ "${ARG_SKIP_ST}" == false ]]; then
    echo "  2. Restart SillyTavern."
    echo "  3. Refresh your SillyTavern browser tab."
fi
echo
