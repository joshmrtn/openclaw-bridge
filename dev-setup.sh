#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
st_dir="${ST_DIR:-${script_dir}/sillytavern}"
plugin_source="${script_dir}/st-plugin"
plugin_target="${st_dir}/plugins/openclaw-bridge"

if [[ ! -d "${plugin_source}" ]]; then
    printf '%s\n' "Missing plugin source directory: ${plugin_source}" >&2
    exit 1
fi

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

cat <<'EOF'
Next steps:
1. Start or restart SillyTavern.
2. Make a request like:
   curl -X POST http://localhost:8000/api/plugins/openclaw-bridge/generate \
     -H 'Authorization: Bearer YOUR_TOKEN' \
     -H 'Content-Type: application/json' \
     -d '{"character":"Gerard","message":"Hello!","channel":"test","user_id":"u001"}'
3. Refresh or reopen Gerard's chat in ST to confirm the message and mock response are in the UI.
EOF