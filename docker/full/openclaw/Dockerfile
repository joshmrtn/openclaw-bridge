# Full E2E: OC with qa-channel + character-bridge skill + openclaw-bridge plugin.
#
# Requires a pre-built base image: openclaw-bridge:oc-qa
# Build it once with:
#   bash docker/full/build-oc.sh
# (qa-lab must be included alongside qa-channel to trigger OPENCLAW_BUILD_PRIVATE_QA=1,
#  which is required for NON_PACKAGED plugins like qa-channel to appear in dist/extensions/)
#
# Then build this layer (from openclaw-bridge repo root):
#   docker build -t openclaw-bridge:oc-full \
#     -f docker/full/openclaw/Dockerfile .
ARG OC_BASE=openclaw-bridge:oc-qa
FROM ${OC_BASE}

# Add the character-bridge skill into OC's bundled skills directory.
# OC loads skills from /app/skills/<skill-name>/SKILL.md at startup.
# The workspace startup command (see docker-compose.full.yml) copies this
# into the agent workspace so loadWorkspaceSkillEntries picks it up.
COPY --chown=node:node skills/character-bridge/SKILL.md /app/skills/character-bridge/SKILL.md

# Copy the repo so the pre-start command can run `openclaw plugins install /repo/oc-plugin`.
# (.dockerignore excludes node_modules/, data/, .git/, sillytavern/)
COPY --chown=node:node . /repo/

USER node
