# 2B Desk — one container: the API, the realtime engine and the dashboard.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev && npm cache clean --force

COPY server/src ./server/src
COPY server/migrations ./server/migrations
COPY server/scripts ./server/scripts
COPY web ./web

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/api/health > /dev/null || exit 1
CMD ["node", "server/src/index.js"]
