FROM node:22-alpine
RUN apk add --no-cache wget
WORKDIR /app
COPY server.js .
EXPOSE 15000
CMD ["node", "server.js"]
