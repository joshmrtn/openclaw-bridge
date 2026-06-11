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

echo
echo "Next steps:"
echo "- Link each SillyTavern character to an OC agent:"
echo "  ./scripts/link-character.sh --character \"My Character\" --agent my-agent --owner \"discord:YOUR_USER_ID\""
echo "- Set OPENCLAW_BRIDGE_URL and OPENCLAW_BRIDGE_TOKEN in each OC agent's env config."
echo "  Token: $(cat ${token_file})"
echo "- Install the skill into an agent workspace:"
echo "  cp -r skills/character-bridge ~/.openclaw/workspace-{agentname}/skills/"
echo "- Restart the OpenClaw gateway after updating agent configs."
echo "- See README.md for the full setup guide."
echo
echo "Setup complete (idempotent)."
