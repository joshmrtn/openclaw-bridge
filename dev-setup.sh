#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
st_dir="${ST_DIR:-${script_dir}/sillytavern}"
plugin_source="${script_dir}/st-plugin"
plugin_target="${st_dir}/plugins/openclaw-bridge"
extension_source="${script_dir}/st-extension"
extension_target="${st_dir}/public/scripts/extensions/openclaw-bridge"
oc_plugin_source="${script_dir}/oc-plugin"
oc_extension_target="${OC_DIR:-${HOME}/.openclaw}/extensions/openclaw-bridge"

if [[ ! -d "${plugin_source}" ]]; then
    printf '%s\n' "Missing plugin source directory: ${plugin_source}" >&2
    exit 1
fi

# Build the extension bundle before symlinking so ST loads a current copy.
printf '%s\n' "Building extension bundle..."
npm --prefix "${script_dir}" run build:extension
printf '%s\n' "Extension bundle built."

if [[ ! -d "${st_dir}" ]]; then
    printf '%s\n' "Missing SillyTavern directory: ${st_dir}" >&2
    printf '%s\n' "Set ST_DIR=/path/to/SillyTavern and run this script again." >&2
    exit 1
fi

mkdir -p "${st_dir}/plugins"

if [[ -e "${plugin_target}" || -L "${plugin_target}" ]]; then
    if [[ -L "${plugin_target}" ]]; then
        current_target="$(readlink "${plugin_target}")"
        if [[ "${current_target}" == "${plugin_source}" ]]; then
            printf '%s\n' "Development symlink already points to ${plugin_source}"
        else
            printf '%s\n' "Refusing to replace existing symlink ${plugin_target} -> ${current_target}" >&2
            exit 1
        fi
    else
        printf '%s\n' "Refusing to overwrite existing path: ${plugin_target}" >&2
        exit 1
    fi
else
    ln -s "${plugin_source}" "${plugin_target}"
    printf '%s\n' "Linked ${plugin_target} -> ${plugin_source}"
fi

# Link extension into ST
mkdir -p "${st_dir}/public/scripts/extensions"

if [[ -e "${extension_target}" || -L "${extension_target}" ]]; then
    if [[ -L "${extension_target}" ]]; then
        current_target="$(readlink "${extension_target}")"
        if [[ "${current_target}" == "${extension_source}" ]]; then
            printf '%s\n' "Development symlink already points to ${extension_source}"
        else
            printf '%s\n' "Refusing to replace existing symlink ${extension_target} -> ${current_target}" >&2
            exit 1
        fi
    else
        printf '%s\n' "Refusing to overwrite existing path: ${extension_target}" >&2
        exit 1
    fi
else
    ln -s "${extension_source}" "${extension_target}"
    printf '%s\n' "Linked ${extension_target} -> ${extension_source}"
fi

# Link OC plugin into OpenClaw extensions
if [[ -d "${oc_extension_target}" || -L "${oc_extension_target}" ]]; then
    if [[ -L "${oc_extension_target}" ]]; then
        current_target="$(readlink "${oc_extension_target}")"
        if [[ "${current_target}" == "${oc_plugin_source}" ]]; then
            printf '%s\n' "OC extension symlink already points to ${oc_plugin_source}"
        else
            printf '%s\n' "Refusing to replace existing OC extension symlink ${oc_extension_target} -> ${current_target}" >&2
            exit 1
        fi
    else
        # Installed copy — replace with a symlink so changes are picked up live.
        printf '%s\n' "Replacing installed OC extension copy with symlink -> ${oc_plugin_source}"
        rm -rf "${oc_extension_target}"
        ln -s "${oc_plugin_source}" "${oc_extension_target}"
        printf '%s\n' "Linked ${oc_extension_target} -> ${oc_plugin_source}"
    fi
else
    ln -s "${oc_plugin_source}" "${oc_extension_target}"
    printf '%s\n' "Linked ${oc_extension_target} -> ${oc_plugin_source}"
fi

cat <<'EOF'
Next steps:
1. Start or restart SillyTavern.
2. Restart OpenClaw (so it picks up the newly linked OC extension).
3. Make a request like:
   curl -X POST http://localhost:8000/api/plugins/openclaw-bridge/generate \
     -H 'Authorization: Bearer YOUR_TOKEN' \
     -H 'Content-Type: application/json' \
     -d '{"character":"Frog","message":"Hello!","channel":"test","user_id":"u001"}'
4. Refresh or reopen Frog's chat in ST to confirm the message and mock response are in the UI.
EOF