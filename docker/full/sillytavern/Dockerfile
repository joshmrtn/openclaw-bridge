FROM ghcr.io/sillytavern/sillytavern:latest

# Install system Chromium via Alpine apk.
# We skip Playwright's bundled browser download and point it at the system binary
# via CHROMIUM_EXECUTABLE_PATH, which headless-service.js reads as executablePath.
# bash/curl/python3 are required by setup.sh and link-character.sh.
USER root

RUN apk add --no-cache \
    bash \
    chromium \
    curl \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    python3

WORKDIR /home/node/app

# Install playwright package without downloading its bundled browser.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install playwright@latest --save --no-audit --no-fund

# Copy the repo so the entrypoint can run setup.sh to install the plugin and extension.
# (.dockerignore excludes sillytavern/, node_modules/, data/, .git/)
COPY --chown=node:node . /repo/

# Copy test character cards (simulates a user placing downloaded character cards into ST).
COPY --chown=node:node docker/test-data/characters/ /home/node/app/data/default-user/characters/

# Pre-configure ST to use the fake-ollama backend.
COPY --chown=node:node docker/full/sillytavern/settings.json /home/node/app/data/default-user/settings.json

# ST config: disable CSRF, enable server plugins, disable browser auto-launch.
COPY --chown=node:node docker/full/sillytavern/config.yaml /home/node/app/config/config.yaml

# Entrypoint runs setup.sh before ST starts, then execs the original tini entrypoint.
COPY docker/full/sillytavern/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER node

ENTRYPOINT ["/entrypoint.sh"]
CMD ["tini", "--", "./docker-entrypoint.sh"]
