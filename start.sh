#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "openclaw-bridge start: starting SillyTavern (OpenClaw is managed separately)"

# Docker check (non-fatal)
if command -v docker >/dev/null 2>&1; then
	if docker info >/dev/null 2>&1; then
		echo "Docker available"
	else
		echo "Warning: Docker present but not responding."
	fi
else
	echo "Note: docker not found; continue if you don't need Docker."
fi

# OC gateway preflight — the bridge is useless without OC running, so warn loudly
OC_OK=0
if command -v openclaw >/dev/null 2>&1; then
	if openclaw health >/dev/null 2>&1; then
		echo "OpenClaw gateway: OK"
		OC_OK=1
	fi
fi
if [ "${OC_OK}" -eq 0 ] && command -v curl >/dev/null 2>&1; then
	if curl -sS --max-time 3 http://localhost:18789/health >/dev/null 2>&1; then
		echo "OpenClaw gateway: OK (localhost:18789)"
		OC_OK=1
	fi
fi
if [ "${OC_OK}" -eq 0 ]; then
	echo ""
	echo "  ╔══════════════════════════════════════════════════════════════╗"
	echo "  ║  WARNING: OpenClaw gateway is not reachable                 ║"
	echo "  ║  The bridge will NOT receive any channel messages until OC  ║"
	echo "  ║  is running.  Start it first:  openclaw gateway start       ║"
	echo "  ╚══════════════════════════════════════════════════════════════╝"
	echo ""
fi

# Start SillyTavern from bundled checkout if present
if [ -x "${script_dir}/sillytavern/start.sh" ]; then
	echo "Starting SillyTavern via ./sillytavern/start.sh (runs in foreground)."
	echo "If you prefer backgrounded execution, run it yourself with '&' or use a service manager."
	exec "${script_dir}/sillytavern/start.sh"
else
	echo "No SillyTavern start script found at ./sillytavern/start.sh — start ST manually."
fi
