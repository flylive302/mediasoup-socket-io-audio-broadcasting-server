# Build stage - using Debian for GCC compatibility with mediasoup
FROM node:24-bookworm AS builder

WORKDIR /app

# Install build dependencies required by mediasoup
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy config files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies (including dev deps for build)
RUN npm ci

# Copy source
COPY src ./src

# Build
RUN npm run build

# Production stage - using slim Debian image
FROM node:24-bookworm-slim AS production

WORKDIR /app

# Copy config
COPY package*.json ./

# Install system dependencies for mediasoup, install npm deps, then cleanup.
# ffmpeg is a RUNTIME dependency (realtime-09 broadcast HLS mixer) — it stays
# after cleanup, unlike the build-only python3-pip/build-essential. Stock ffmpeg
# carries the `aac` encoder we need; no extra codecs required.
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    build-essential \
    wget \
    ffmpeg \
    && npm ci --omit=dev \
    && apt-get remove -y python3-pip build-essential \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
    
# Copy built assets.
# `/app/dist/*.js` — NOT `/app/dist` — because the build now emits `.js.map`
# sourcemaps for Sentry, and this image is published to a public registry.
# The maps are uploaded to Sentry from the builder stage instead (see §10 of
# docs/issues/msab-sentry/prd-msab-sentry.md); they must never ship in a layer.
COPY --from=builder /app/dist/*.js ./dist/

# Env variables should be set by runtime (DO App Platform)
ENV NODE_ENV=production
ENV PORT=3030

# Expose ports
EXPOSE 3030
# MediaSoup RTC Ports (UDP/TCP)
EXPOSE 10000-59999/udp
EXPOSE 10000-59999/tcp

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3030/health || exit 1

# Start.
# `--import` (not a top-level import in index.ts): under ESM the hoisted
# imports of index.ts would evaluate before Sentry.init() ran, so
# auto-instrumentation could silently fail to patch. NODE_OPTIONS was rejected
# as invisible here and container-wide.
CMD ["node", "--import", "./dist/instrument.js", "dist/index.js"]
