FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Build tools only needed if better-sqlite3 has no prebuilt binary for the platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    GROUPBET_ADAPTER=whatsapp \
    GROUPBET_DB=/app/data/groupbet.db \
    GROUPBET_AUTH_DIR=/app/auth
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
VOLUME ["/app/auth", "/app/data"]
CMD ["npx", "tsx", "src/index.ts"]
