#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "openclaw-bridge setup — verifying prerequisites and wiring plugin"

# Node.js check (prefer v22+)
if command -v node >/dev/null 2>&1; then
	node_ver=$(node -v | sed 's/^v//')
	node_major=${node_ver%%.*}
	if [ "${node_major}" -lt 22 ]; then
		echo "Warning: Node.js version ${node_ver} detected — Node 22+ is recommended."
	else
		echo "Node.js ${node_ver} OK"
	fi
else
	echo "Warning: node not found in PATH. Install Node.js 22+ before proceeding."
fi

# OpenClaw CLI check
if command -v openclaw >/dev/null 2>&1; then
	echo "openclaw CLI found: $(openclaw --version 2>/dev/null || echo '(version unknown)')"
else
	echo "Warning: openclaw CLI not found in PATH. Ensure OpenClaw is installed and accessible."
fi

# Docker check (non-fatal)
if command -v docker >/dev/null 2>&1; then
	if docker info >/dev/null 2>&1; then
		echo "Docker appears available"
	else
		echo "Warning: Docker present but not responding — it may be stopped."
	fi
else
	echo "Warning: docker not found. Install Docker if you need containerized services."
fi

# Check OpenClaw health endpoint (best-effort)
if command -v curl >/dev/null 2>&1; then
	if curl -sS --max-time 3 http://localhost:18789/health >/dev/null 2>&1; then
		echo "OpenClaw health OK (http://localhost:18789/health)"
	else
		echo "Note: OpenClaw health check failed or OpenClaw not running — this is a warning only."
	fi
fi

# Symlink plugin into SillyTavern (dev-friendly)
if [ -d "${script_dir}/sillytavern" ]; then
	echo "Linking plugin into SillyTavern (dev mode)"
	bash "${script_dir}/dev-setup.sh"
else
	echo "SillyTavern checkout not present at ${script_dir}/sillytavern — skipping dev symlink."
fi

# Install Node deps for plugin
if [ -d "${script_dir}/st-plugin" ]; then
	echo "Installing st-plugin npm dependencies..."
	(cd "${script_dir}/st-plugin" && npm install --no-audit --no-fund)
fi

# Install ST browser extension (symlink for dev checkout, copy fallback for production)
if [ -d "${script_dir}/st-extension" ]; then
	# Dev checkout: SillyTavern is checked out in ./sillytavern
	st_ext_dir="${script_dir}/sillytavern/public/scripts/extensions"
	if [ -d "${st_ext_dir}" ]; then
		ext_dst="${st_ext_dir}/openclaw-bridge"
		if [ ! -e "${ext_dst}" ] && [ ! -L "${ext_dst}" ]; then
			ln -s "${script_dir}/st-extension" "${ext_dst}"
			echo "Linked ST extension (dev): ${ext_dst}"
		else
			echo "ST extension already present at ${ext_dst}"
		fi
	else
		# No dev checkout — emit instruction for manual install
		echo "Note: SillyTavern checkout not found at ${script_dir}/sillytavern"
		echo "  Install the ST extension manually:"
		echo "  cp -r ${script_dir}/st-extension /path/to/SillyTavern/public/scripts/extensions/openclaw-bridge"
	fi
fi

# Ensure bridge auth token exists (generate if missing)
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
	echo "Generated bridge auth token at ${token_file}"
else
	echo "Existing bridge token found at ${token_file}"
fi

# Symlink data files into ~/.openclaw/openclaw-bridge/ so the OC gateway plugin
# can find them at their default paths without needing env vars.
oc_data_dir="${HOME}/.openclaw/openclaw-bridge"
mkdir -p "${oc_data_dir}"

links_file="${token_dir}/character-links.json"
if [ ! -f "${links_file}" ]; then
	printf '{}' > "${links_file}"
	echo "Created empty character-links.json at ${links_file}"
fi

for fname in bridge-token.txt character-links.json; do
	src="${token_dir}/${fname}"
	dst="${oc_data_dir}/${fname}"
	if [ ! -e "${dst}" ] && [ ! -L "${dst}" ]; then
		ln -s "${src}" "${dst}"
		echo "Linked ${dst} -> ${src}"
	else
		echo "Already exists: ${dst}"
	fi
done

# Install the OC gateway plugin (requires openclaw CLI)
if command -v openclaw >/dev/null 2>&1; then
	echo "Installing OC gateway plugin from ${script_dir}/oc-plugin..."
	openclaw plugins install --path "${script_dir}/oc-plugin" 2>&1 || \
		echo "Warning: plugin install failed — run 'openclaw plugins install --path ${script_dir}/oc-plugin' manually after starting the gateway."
else
	echo "Note: openclaw CLI not found — install the OC gateway plugin manually:"
	echo "  openclaw plugins install --path ${script_dir}/oc-plugin"
fi

echo
echo "Next steps:"
echo "- Link each SillyTavern character to an OC agent:"
echo "  ./scripts/link-character.sh --character \"My Character\" --agent my-agent --owner \"discord:YOUR_USER_ID\""
echo "- Token (for OC agent env config): $(cat "${token_file}")"
echo "- Install the character-bridge skill into each agent workspace:"
echo "  cp -r skills/character-bridge ~/.openclaw/workspace-{agentname}/skills/"
echo "- Restart the OpenClaw gateway after installing the plugin:"
echo "  openclaw gateway restart"
echo "- See README.md and AGENT-SETUP.md for the full setup guide."
echo
echo "Setup complete (idempotent)."
