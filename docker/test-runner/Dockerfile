FROM node:22-alpine
RUN apk add --no-cache bash curl python3

WORKDIR /runner
COPY docker/test-runner/package.json .
RUN npm install --no-audit --no-fund --quiet

# Copy the repo for setup.sh / link-character.sh integration tests.
COPY . /repo

# Pre-install st-plugin deps so setup.sh's npm install step is cached and
# works even if the container has no outbound network during tests.
RUN cd /repo/st-plugin && npm install --no-audit --no-fund --quiet

COPY docker/test-runner/e2e.test.js .

CMD ["npm", "test"]
