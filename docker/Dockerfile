# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy config files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies (including dev deps for build)
RUN npm ci

# Copy source
COPY src ./src

# Build
RUN npm run build

# Production stage
FROM node:22-alpine AS production

WORKDIR /app

# Copy config
COPY package*.json ./

# Install system dependencies for mediasoup build, then cleanup
RUN apk add --no-cache --virtual .build-deps python3 make g++ linux-headers \
    && npm ci --only=production \
    && apk del .build-deps

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
