FROM node:22
WORKDIR /repo
COPY package*.json ./
RUN npm ci
RUN npx playwright install chromium --with-deps
COPY . .
CMD ["npx", "playwright", "test", "-c", "st-plugin/tests/e2e/playwright.config.js"]
