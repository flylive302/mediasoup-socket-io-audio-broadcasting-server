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

# Install system dependencies for mediasoup, install npm deps, then cleanup
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    build-essential \
    wget \
    && npm ci --omit=dev \
    && apt-get remove -y python3-pip build-essential \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
    
# Copy version.json if available (generated during build)
COPY --from=builder /app/src/version.json ./version.json*

# Copy built assets
COPY --from=builder /app/dist ./dist

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

# Start
CMD ["node", "dist/index.js"]
