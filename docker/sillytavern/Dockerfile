FROM ghcr.io/sillytavern/sillytavern:latest

# Copy the bridge plugin and extension into the ST installation.
# ST finds ws at /home/node/app/node_modules/ws, so no separate npm install needed.
COPY --chown=node:node st-plugin/ /home/node/app/plugins/openclaw-bridge/
COPY --chown=node:node st-extension/ /home/node/app/public/scripts/extensions/third-party/openclaw-bridge/

# Copy test character cards so the plugin can resolve character names.
COPY --chown=node:node docker/test-data/characters/ /home/node/app/data/default-user/characters/

# Copy test-scoped config (disableCsrfProtection, whitelistMode: false, etc.).
COPY --chown=node:node docker/sillytavern/config.yaml /home/node/app/config/config.yaml
