FROM node:24-alpine

WORKDIR /app

COPY backend/package.json ./backend/package.json
COPY backend/server.js ./backend/server.js
COPY backend/ai ./backend/ai
COPY backend/docker-entrypoint.sh ./backend/docker-entrypoint.sh
COPY backend/config/local-config.example.json ./backend/config/local-config.example.json
COPY backend/data/profile.example.json ./backend/data/profile.example.json
COPY vendor ./vendor

WORKDIR /app/backend

EXPOSE 17840

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:17840/health >/dev/null || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
