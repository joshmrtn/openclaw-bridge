#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "openclaw-bridge start: start SillyTavern (OpenClaw is managed separately)"

# Docker check (don't fail)
if command -v docker >/dev/null 2>&1; then
	if docker info >/dev/null 2>&1; then
		echo "Docker available"
	else
		echo "Warning: Docker present but not responding."
	fi
else
	echo "Note: docker not found; continue if you don't need Docker." 
fi

# Start SillyTavern from bundled checkout if present
if [ -x "${script_dir}/sillytavern/start.sh" ]; then
	echo "Starting SillyTavern via ./sillytavern/start.sh (runs in foreground)."
	echo "If you prefer backgrounded execution, run it yourself with '&' or use a service manager."
	exec "${script_dir}/sillytavern/start.sh"
else
	echo "No SillyTavern start script found at ./sillytavern/start.sh — start ST manually."
fi
