#!/usr/bin/env bash
# Build the OC Docker images needed for the full E2E tier.
#
# Step 1: Build OC with qa-channel extension → openclaw-bridge:oc-qa
# Step 2: Extend that image with our character-bridge skill → openclaw-bridge:oc-full
#
# Usage:
#   bash docker/full/build-oc.sh
#   OC_REPO=/path/to/openclaw bash docker/full/build-oc.sh
#
# OC_REPO defaults to ~/projects/openclaw.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OC_REPO="${OC_REPO:-${HOME}/projects/openclaw}"

if [[ ! -d "${OC_REPO}" ]]; then
  echo "ERROR: OC repo not found at ${OC_REPO}" >&2
  echo "       Clone openclaw and set OC_REPO=/path/to/openclaw" >&2
  exit 1
fi

if [[ ! -f "${OC_REPO}/Dockerfile" ]]; then
  echo "ERROR: No Dockerfile found at ${OC_REPO}/Dockerfile" >&2
  exit 1
fi

echo "==> Step 1: Building OC with qa-channel extension → openclaw-bridge:oc-qa"
# qa-lab is included alongside qa-channel because the OC Dockerfile only sets
# OPENCLAW_BUILD_PRIVATE_QA=1 when qa-lab is present. That env var is required
# by copy-bundled-plugin-metadata.mjs to include NON_PACKAGED plugins (like
# qa-channel) in dist/extensions/. Without it, qa-channel's dist dir is removed.
echo "    Context: ${OC_REPO}"
docker build \
  -t openclaw-bridge:oc-qa \
  --build-arg OPENCLAW_EXTENSIONS="qa-channel,qa-lab" \
  -f "${OC_REPO}/Dockerfile" \
  "${OC_REPO}"

echo ""
echo "==> Step 2: Adding character-bridge skill → openclaw-bridge:oc-full"
echo "    Context: ${REPO_DIR}"
docker build \
  -t openclaw-bridge:oc-full \
  -f "${SCRIPT_DIR}/openclaw/Dockerfile" \
  "${REPO_DIR}"

echo ""
echo "✓ Done. Images built:"
echo "  openclaw-bridge:oc-qa   — OC + qa-channel extension"
echo "  openclaw-bridge:oc-full — OC + qa-channel + character-bridge skill"
echo ""
echo "Next: npm run test:e2e:full"
