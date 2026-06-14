FROM node:22-alpine
RUN apk add --no-cache bash curl wget python3 docker-cli
WORKDIR /runner
COPY docker/full/test-runner/package.json .
RUN npm install --no-audit --no-fund --quiet
COPY . /repo
COPY docker/full/test-runner/full-e2e.test.js .
CMD ["npm", "test"]
