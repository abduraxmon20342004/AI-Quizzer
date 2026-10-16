# syntax=docker/dockerfile:1
# Debian slim (glibc) because @napi-rs/canvas (used for OCR of scanned PDFs) ships glibc binaries.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY samples ./samples
COPY data ./data
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/.data && chown node:node /app/.data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
# Railway sets PORT (and uses its own health check on /healthz); elsewhere the app listens on 8080.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD curl -fsS "http://localhost:${PORT:-8080}/healthz" || exit 1
CMD ["node", "dist/src/main.js"]
