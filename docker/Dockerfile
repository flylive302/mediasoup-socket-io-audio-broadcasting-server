# syntax=docker/dockerfile:1
# ^ Required for `RUN --mount=type=secret` (the Sentry sourcemap upload below).
# buildx already enables BuildKit, but the directive removes all doubt.

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

# msab-sentry §10: upload sourcemaps to Sentry HERE, in the builder — `dist/`
# (and its `.js.map` files) exists only in this stage; the CI runner never has
# it, and the shipped image strips the maps (the `/app/dist/*.js` COPY below).
#
# ARG is declared LATE, right before its only consumer, so the release string —
# which changes every commit — never busts the cached npm-ci/build layers above.
#
# `sourcemaps inject` stamps matching debug IDs into the .js and .js.map before
# the .js are copied into the image, so frames resolve even if the release
# string ever drifts (belt-and-suspenders over the byte-exact release wiring).
#
# `@sentry/cli` is a pinned devDependency, so the binary is already in
# node_modules from `npm ci` above — no network fetch mid-build.
#
# Presence-skip vs error-swallow are deliberately distinct: a MISSING token
# (local `docker build` without the secret) warns and continues; a PRESENT
# token whose upload FAILS aborts the build (`set -e`). The compensating loud
# gate for a genuinely-missing token in CI is the hard-fail `releases
# new/finalize` step in ghcr-publish.yml, which needs the same token.
ARG SENTRY_RELEASE
RUN --mount=type=secret,id=sentry_token \
    set -e; \
    if [ -s /run/secrets/sentry_token ]; then \
      export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_token)"; \
      ./node_modules/.bin/sentry-cli sourcemaps inject ./dist; \
      ./node_modules/.bin/sentry-cli sourcemaps upload \
        --org flylive --project node-msab --release "$SENTRY_RELEASE" ./dist; \
    else \
      echo "WARNING: sentry_token build secret absent — skipping sourcemap upload (frames will be minified for this build)."; \
    fi

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
