FROM node:22-alpine
WORKDIR /app
COPY package.json .
RUN npm install --no-audit --no-fund --quiet
COPY index.js .
CMD ["node", "index.js"]
