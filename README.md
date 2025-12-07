# FlyLive Audio Server - Complete Technical Documentation

> **Production-Ready Audio-Only Conferencing Backend**  
> _Powered by Fastify, Mediasoup, Socket.IO, Redis, and TypeScript_

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Technology Stack](#3-technology-stack)
4. [Project Structure](#4-project-structure)
5. [Core Components](#5-core-components)
6. [Socket.IO Events Reference](#6-socketio-events-reference)
7. [Configuration](#7-configuration)
8. [Development Setup](#8-development-setup)
9. [Deployment Guide](#9-deployment-guide)
10. [Capacity Planning](#10-capacity-planning)
11. [Security](#11-security)
12. [Monitoring & Health Checks](#12-monitoring--health-checks)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Overview

**FlyLive Audio Server** is a high-performance, horizontally scalable, audio-only conferencing backend designed for real-time interaction in social/live-streaming applications. It handles:

- **Real-time signaling** via Socket.IO
- **Audio streaming** via Mediasoup SFU (Selective Forwarding Unit)
- **Room state management** via Redis
- **Chat messaging** with rate limiting
- **Gift transactions** with batched processing
- **Active speaker detection** for UI highlights
- **Integration with Laravel backend** for auth and business logic

### Use Case

Audio rooms with up to **15 active speakers** and **hundreds of listeners** per room - similar to Twitter Spaces, Clubhouse, or Discord Stage Channels.

---

## 2. Architecture

### System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND (Nuxt/Vue)                            │
│                                                                             │
│   ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐        │
│   │  mediasoup-client│    │   socket.io-client│   │    UI Components │        │
│   └────────┬────────┘    └────────┬────────┘    └─────────────────┘        │
└────────────┼──────────────────────┼─────────────────────────────────────────┘
             │ WebRTC               │ WebSocket
             │                      │
┌────────────▼──────────────────────▼─────────────────────────────────────────┐
│                         AUDIO SERVER (This Project)                         │
│                                                                             │
│   ┌───────────────────────────────────────────────────────────────────┐    │
│   │                        Fastify HTTP Server                        │    │
│   │                    (Health Checks, Metrics)                       │    │
│   └───────────────────────────────────────────────────────────────────┘    │
│                                    │                                        │
│   ┌───────────────────────────────────────────────────────────────────┐    │
│   │                     Socket.IO Server                               │    │
│   │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌──────────┐ │    │
│   │   │ RoomHandler │  │ MediaHandler│  │ ChatHandler │  │GiftHandler│ │    │
│   │   └─────────────┘  └─────────────┘  └─────────────┘  └──────────┘ │    │
│   └───────────────────────────────────────────────────────────────────┘    │
│                                    │                                        │
│   ┌────────────────────────────────┴────────────────────────────────┐      │
│   │                                                                  │      │
│   │  ┌──────────────┐  ┌───────────────┐  ┌───────────────────────┐ │      │
│   │  │ RoomManager  │  │ WorkerManager │  │ ClientManager          │ │      │
│   │  └──────────────┘  └───────────────┘  └───────────────────────┘ │      │
│   │                                                                  │      │
│   │  ┌──────────────┐  ┌───────────────┐  ┌───────────────────────┐ │      │
│   │  │RouterManager │  │ GiftBuffer    │  │ SanctumValidator      │ │      │
│   │  │ (per room)   │  │ (batching)    │  │ (auth caching)        │ │      │
│   │  └──────────────┘  └───────────────┘  └───────────────────────┘ │      │
│   │                                                                  │      │
│   └──────────────────────────────────────────────────────────────────┘      │
│                    │                              │                         │
│   ┌────────────────▼─────┐           ┌───────────▼─────────────┐           │
│   │   Mediasoup Workers  │           │        Redis            │           │
│   │   (1 per CPU core)   │           │   (State + Pub/Sub)     │           │
│   └──────────────────────┘           └─────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        │ HTTP (Internal API)
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          LARAVEL BACKEND                                    │
│                                                                             │
│   ┌─────────────────────┐  ┌─────────────────────┐  ┌──────────────────┐   │
│   │ /internal/auth/     │  │ /internal/gifts/    │  │ /internal/rooms/ │   │
│   │   validate          │  │   batch             │  │   {id}/status    │   │
│   └─────────────────────┘  └─────────────────────┘  └──────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Connection**: Client connects via Socket.IO with Sanctum token
2. **Authentication**: Token validated against Laravel API, cached in Redis
3. **Room Join**: Client joins room, receives RTP capabilities
4. **Transport Creation**: Client creates WebRTC transports for send/receive
5. **Audio Production**: Speakers produce audio streams
6. **Audio Consumption**: Listeners consume audio from active speakers
7. **Chat/Gifts**: Real-time messaging and gift transactions
8. **Cleanup**: Proper resource cleanup on disconnect

---

## 3. Technology Stack

### Runtime & Framework

| Technology     | Version | Purpose             |
| -------------- | ------- | ------------------- |
| **Node.js**    | ≥22.0.0 | Runtime (ESM)       |
| **TypeScript** | ^5.7.0  | Type safety         |
| **Fastify**    | ^5.0.0  | HTTP server         |
| **Socket.IO**  | ^4.8.1  | Real-time signaling |

### Media & State

| Technology    | Version | Purpose               |
| ------------- | ------- | --------------------- |
| **Mediasoup** | ^3.15.7 | SFU audio routing     |
| **Redis**     | ≥7.0    | State store & pub/sub |
| **ioredis**   | ^5.4.1  | Redis client          |

### Utilities

| Technology | Version | Purpose            |
| ---------- | ------- | ------------------ |
| **Zod**    | ^3.24.0 | Runtime validation |
| **Pino**   | ^9.5.0  | Structured logging |
| **dotenv** | ^16.4.0 | Environment config |

### Development

| Technology   | Purpose              |
| ------------ | -------------------- |
| **tsx**      | TypeScript execution |
| **tsup**     | Build bundler        |
| **Vitest**   | Testing framework    |
| **ESLint**   | Code linting         |
| **Prettier** | Code formatting      |

---

## 4. Project Structure

```
flylive-audio-server/
├── src/
│   ├── index.ts              # Entry point, graceful shutdown
│   ├── context.ts            # AppContext type definition
│   ├── types.ts              # Re-exports all types
│   │
│   ├── auth/
│   │   ├── middleware.ts     # Socket.IO auth middleware
│   │   ├── sanctumValidator.ts  # Laravel token validation + caching
│   │   └── types.ts          # AuthenticatedUser, AuthSocketData
│   │
│   ├── client/
│   │   └── clientManager.ts  # Track connected clients and their resources
│   │
│   ├── config/
│   │   ├── index.ts          # Zod-validated environment config
│   │   └── mediasoup.ts      # Mediasoup-specific settings
│   │
│   ├── core/
│   │   ├── health.ts         # /health endpoint
│   │   ├── logger.ts         # Pino logger setup
│   │   ├── metrics.ts        # /metrics endpoint
│   │   ├── redis.ts          # Redis client singleton
│   │   └── server.ts         # Fastify + Socket.IO bootstrap
│   │
│   ├── gifts/
│   │   ├── giftBuffer.ts     # Batched gift processing
│   │   └── giftHandler.ts    # gift:send event handler
│   │
│   ├── integrations/
│   │   ├── laravelClient.ts  # HTTP client for Laravel APIs
│   │   └── types.ts          # GiftTransaction, RoomStatusUpdate
│   │
│   ├── mediasoup/
│   │   ├── activeSpeaker.ts  # Active speaker detection
│   │   ├── routerManager.ts  # Per-room mediasoup router
│   │   └── workerManager.ts  # Worker pool management
│   │
│   ├── room/
│   │   ├── roomManager.ts    # Room lifecycle management
│   │   ├── roomState.ts      # Redis state persistence
│   │   ├── seatManager.ts    # Speaker seat management
│   │   └── types.ts          # RoomState, Seat types
│   │
│   ├── socket/
│   │   ├── index.ts          # Socket initialization
│   │   ├── schemas.ts        # Zod schemas for all events
│   │   ├── schemas.test.ts   # Schema tests
│   │   └── handlers/
│   │       ├── roomHandler.ts    # room:join, room:leave
│   │       ├── mediaHandler.ts   # transport, produce, consume
│   │       └── chatHandler.ts    # chat:message
│   │
│   └── utils/
│       ├── crypto.ts         # Token hashing
│       ├── rateLimiter.ts    # Redis rate limiting
│       └── rateLimiter.test.ts
│
├── docker/
│   ├── Dockerfile            # Multi-stage production build
│   └── app.yaml              # Digital Ocean App Platform config
│
├── docs/
│   ├── DOCUMENTATION.md      # This file
│   ├── FRONTEND_INTEGRATION.md   # Frontend guide
│   └── LARAVEL_REQUIREMENTS.md   # Backend requirements
│
├── .github/
│   └── workflows/
│       └── ci.yml            # GitHub Actions CI
│
├── .env.example              # Environment template
├── package.json
└── tsconfig.json
```

---

## 5. Core Components

### WorkerManager (`src/mediasoup/workerManager.ts`)

Manages a pool of Mediasoup workers (one per CPU core).

- **Initialization**: Creates workers on startup
- **Load Balancing**: Routes new rooms to least-loaded worker
- **Recovery**: Restarts workers that die unexpectedly
- **Metrics**: Tracks router count per worker

### RoomManager (`src/room/roomManager.ts`)

Orchestrates room lifecycle.

- **Create Room**: Allocates worker, creates router, initializes state
- **Close Room**: Notifies clients, updates Laravel, cleans resources
- **State Sync**: Persists room state to Redis

### RouterManager (`src/mediasoup/routerManager.ts`)

Manages a single Mediasoup router (one per room).

- **Transports**: Creates/manages WebRTC transports
- **Producers**: Tracks audio producers (speakers)
- **Consumers**: Tracks audio consumers (listeners)
- **Active Speaker**: Detects dominant speaker

### GiftBuffer (`src/gifts/giftBuffer.ts`)

Batches gift transactions for efficiency.

- **Queue**: Accumulates gifts in Redis list
- **Flush Interval**: 500ms batch processing
- **Retry Logic**: Re-queues failed transactions
- **Error Notification**: Notifies senders of failures via Socket.IO

### SanctumValidator (`src/auth/sanctumValidator.ts`)

Validates Laravel Sanctum tokens with caching.

- **Revocation Check**: Checks Redis revocation list first
- **Cache**: 5-minute TTL for validated tokens
- **Fallback**: Calls Laravel API on cache miss

### ClientManager (`src/client/clientManager.ts`)

Tracks connected clients and their resources.

```typescript
interface ClientData {
  socketId: string;
  userId: number;
  user: AuthenticatedUser;
  roomId?: string;
  isSpeaker: boolean;
  joinedAt: number;
  producers: Map<string, string>; // kind → producerId
  consumers: Map<string, string>; // producerId → consumerId
  transports: Map<string, string>; // transportId → type
}
```

---

## 6. Socket.IO Events Reference

### Quick Reference

| Event               | Direction | Purpose                         |
| ------------------- | --------- | ------------------------------- |
| `room:join`         | C→S       | Join room, get RTP capabilities |
| `room:leave`        | C→S       | Leave room                      |
| `room:userJoined`   | S→C       | User joined notification        |
| `room:userLeft`     | S→C       | User left notification          |
| `room:closed`       | S→C       | Room ended notification         |
| `transport:create`  | C→S       | Create WebRTC transport         |
| `transport:connect` | C→S       | Connect transport (DTLS)        |
| `audio:produce`     | C→S       | Start sending audio             |
| `audio:newProducer` | S→C       | Someone started audio           |
| `audio:consume`     | C→S       | Start receiving audio           |
| `consumer:resume`   | C→S       | Unmute consumer                 |
| `chat:message`      | C→S / S→C | Send/receive chat               |
| `gift:send`         | C→S       | Send gift                       |
| `gift:received`     | S→C       | Gift animation trigger          |
| `gift:error`        | S→C       | Gift failed (to sender only)    |
| `speaker:active`    | S→C       | Active speaker changed          |
| `error`             | S→C       | Generic error                   |

### Payload Schemas (Zod)

All payloads are validated using Zod schemas in `src/socket/schemas.ts`:

```typescript
// Room
joinRoomSchema:    { roomId: UUID }
leaveRoomSchema:   { roomId: UUID }

// Transport
transportCreateSchema:  { type: 'producer'|'consumer', roomId: UUID }
transportConnectSchema: { roomId: UUID, transportId: UUID, dtlsParameters: object }

// Audio
audioProduceSchema:  { roomId: UUID, transportId: UUID, kind: 'audio', rtpParameters: object }
audioConsumeSchema:  { roomId: UUID, transportId: UUID, producerId: UUID, rtpCapabilities: object }
consumerResumeSchema: { roomId: UUID, consumerId: UUID }

// Chat
chatMessageSchema: { roomId: UUID, content: string (1-500 chars), type?: string }

// Gifts
sendGiftSchema: { roomId: UUID, giftId: UUID, recipientId: number, quantity?: number }
```

**See `docs/FRONTEND_INTEGRATION.md` for complete event documentation with examples.**

---

## 7. Configuration

### Environment Variables

All configuration is validated at startup using Zod. Invalid config causes immediate exit.

```env
# Server
NODE_ENV=production           # 'development' | 'production' | 'test'
PORT=3030                     # Server port
LOG_LEVEL=info                # 'fatal'|'error'|'warn'|'info'|'debug'|'trace'

# SSL (optional, for direct HTTPS)
SSL_KEY_PATH=/path/to/key.pem
SSL_CERT_PATH=/path/to/cert.pem

# Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=               # Optional
REDIS_DB=3                    # Use separate DB from Laravel

# Laravel Integration (REQUIRED)
LARAVEL_API_URL=https://api.flylive.app
LARAVEL_INTERNAL_KEY=your_32_character_secret_minimum

# MediaSoup
MEDIASOUP_LISTEN_IP=0.0.0.0
MEDIASOUP_ANNOUNCED_IP=       # REQUIRED in production: your public IP
MEDIASOUP_RTC_MIN_PORT=10000  # UDP port range start
MEDIASOUP_RTC_MAX_PORT=59999  # UDP port range end

# Limits
MAX_ROOMS_PER_WORKER=100
MAX_CLIENTS_PER_ROOM=50
RATE_LIMIT_MESSAGES_PER_MINUTE=60

# Security
CORS_ORIGINS=https://app.flylive.app,https://www.flylive.app
```

### MediaSoup Configuration (`src/config/mediasoup.ts`)

```typescript
{
  worker: {
    rtcMinPort: 10000,
    rtcMaxPort: 59999,
    logLevel: 'warn',
  },
  router: {
    mediaCodecs: [{
      kind: 'audio',
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
      parameters: {
        useinbandfec: 1,  // Forward error correction
        usedtx: 0,        // Disable discontinuous transmission
        minptime: 10,     // 10ms packets (low latency)
      },
    }],
  },
  webRtcTransport: {
    maxIncomingBitrate: 128000,  // 128kbps per stream
    initialAvailableOutgoingBitrate: 64000,
  },
  activeSpeakerObserver: {
    interval: 200,   // 200ms check interval
    minVolume: -50,  // dB threshold
  },
}
```

---

## 8. Development Setup

### Prerequisites

- **Node.js** ≥ 22.0.0
- **Redis** ≥ 6.0 (running locally)
- **Python 3** (for mediasoup build)
- **GCC/G++** (for mediasoup build)
- **Linux headers** (for mediasoup, Linux only)

### Installation

```bash
# Clone and install
git clone https://github.com/your-org/flylive-audio-server.git
cd flylive-audio-server
npm install

# Setup environment
cp .env.example .env
# Edit .env with your Laravel API URL and internal key

# Start Redis (if not running)
redis-server
```

### Development Commands

```bash
# Development (hot reload)
npm run dev

# Type checking
npm run typecheck

# Linting
npm run lint

# Formatting
npm run format

# Testing
npm test              # Run tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report

# Production build
npm run build

# Start production
npm start
```

### Local Testing Flow

1. Start Redis: `redis-server`
2. Start audio server: `npm run dev`
3. Server available at `http://localhost:3030`
4. Health check: `curl http://localhost:3030/health`

---

## 9. Deployment Guide

### Option 1: Digital Ocean App Platform (Recommended)

The project includes a ready-to-use `docker/app.yaml` for DO App Platform.

#### Setup Steps

1. **Fork/Clone Repository** to your GitHub account

2. **Update `docker/app.yaml`**:

   ```yaml
   services:
     - name: audio-server
       github:
         repo: YOUR-ORG/flylive-audio-server # ← Update this
         branch: main
   ```

3. **Create App in DO Console**:
   - Go to Digital Ocean → Apps → Create App
   - Choose "Deploy from GitHub"
   - Select your repository
   - Choose "Use app.yaml"

4. **Set Secrets**:
   - Add `LARAVEL_INTERNAL_KEY` as a secret in DO Console

5. **Deploy**: Push to `main` triggers auto-deploy

#### Important Notes

> ⚠️ **UDP Port Limitation**: Digital Ocean App Platform does NOT support UDP ports required for WebRTC. You will need to use Droplets instead for audio streaming.

### Option 2: Digital Ocean Droplets (Production)

For actual WebRTC media, you need Droplets with UDP access.

#### 1. Create Droplet

```bash
# Recommended: CPU-Optimized
doctl compute droplet create audio-server \
  --size c-4 \
  --image docker-22-04 \
  --region sgp1
```

#### 2. Setup Firewall

```bash
# Create firewall
doctl compute firewall create \
  --name audio-server-fw \
  --inbound-rules "protocol:tcp,ports:22,address:0.0.0.0/0 protocol:tcp,ports:3030,address:0.0.0.0/0 protocol:udp,ports:10000-59999,address:0.0.0.0/0 protocol:tcp,ports:10000-59999,address:0.0.0.0/0" \
  --outbound-rules "protocol:tcp,ports:all,address:0.0.0.0/0 protocol:udp,ports:all,address:0.0.0.0/0"
```

#### 3. Deploy via Docker

SSH into your droplet and run:

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Clone repo
git clone https://github.com/your-org/flylive-audio-server.git
cd flylive-audio-server

# Create .env
cat > .env << 'EOF'
NODE_ENV=production
PORT=3030
LOG_LEVEL=info

REDIS_HOST=your-redis-host
REDIS_PORT=25060
REDIS_PASSWORD=your-redis-password
REDIS_DB=3

LARAVEL_API_URL=https://api.flylive.app
LARAVEL_INTERNAL_KEY=your_32_character_secret

MEDIASOUP_LISTEN_IP=0.0.0.0
MEDIASOUP_ANNOUNCED_IP=YOUR_DROPLET_PUBLIC_IP
EOF

# Build and run
docker build -t audio-server -f docker/Dockerfile .
docker run -d \
  --name audio-server \
  --restart unless-stopped \
  --env-file .env \
  -p 3030:3030 \
  -p 10000-59999:10000-59999/udp \
  -p 10000-59999:10000-59999/tcp \
  audio-server
```

#### 4. Setup Managed Redis

```bash
# Create managed Redis
doctl databases create audio-redis \
  --engine redis \
  --size db-s-1vcpu-1gb \
  --region sgp1

# Get connection details
doctl databases get audio-redis
```

### Option 3: Docker Compose (Development/Staging)

Create `docker-compose.yml`:

```yaml
version: "3.8"

services:
  audio-server:
    build:
      context: docs
      dockerfile: docker/Dockerfile
    ports:
      - "3030:3030"
      - "10000-10100:10000-10100/udp" # Limited range for dev
    environment:
      NODE_ENV: production
      PORT: 3030
      REDIS_HOST: redis
      REDIS_PORT: 6379
      REDIS_DB: 3
      LARAVEL_API_URL: http://host.docker.internal:8000
      LARAVEL_INTERNAL_KEY: dev_internal_key_32_characters!!
      MEDIASOUP_LISTEN_IP: 0.0.0.0
      MEDIASOUP_ANNOUNCED_IP: 127.0.0.1
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

volumes:
  redis_data:
```

```bash
docker-compose up -d
```

### Deployment Checklist

- [ ] UDP ports 10000-59999 open in firewall
- [ ] `MEDIASOUP_ANNOUNCED_IP` set to public IP
- [ ] `LARAVEL_INTERNAL_KEY` matches Laravel `.env`
- [ ] Redis accessible from audio server
- [ ] Health check passing: `curl https://audio.example.com/health`
- [ ] Load balancer sticky sessions enabled (if using LB)
- [ ] SSL/TLS configured (via LB or directly)

---

## 10. Capacity Planning

### Model: 15 Speakers + Many Listeners

The system is optimized for audio rooms with up to 15 active speakers and unlimited listeners.

### Per-Room Resources

| Resource                | Value                               |
| ----------------------- | ----------------------------------- |
| **Ingress bandwidth**   | 15 × 128kbps = 1.9 Mbps             |
| **Egress per listener** | 15 × 128kbps = 1.9 Mbps             |
| **Memory**              | ~2-5 MB                             |
| **CPU**                 | Minimal (audio forwarding is cheap) |

### Capacity by Server Size

| Server         | Cores | Rooms | Listeners/Room | Total Users |
| -------------- | ----- | ----- | -------------- | ----------- |
| c-4 (4 vCPU)   | 4     | 200   | 50             | 10,000      |
| c-8 (8 vCPU)   | 8     | 400   | 50             | 20,000      |
| c-16 (16 vCPU) | 16    | 800   | 50             | 40,000      |

### Bandwidth Limits (Primary Bottleneck)

| Server Bandwidth | Max Listeners | Cost Factor |
| ---------------- | ------------- | ----------- |
| 1 Gbps           | ~520/room     | Standard    |
| 10 Gbps          | ~5,200/room   | Premium     |

### Recommended Infrastructure by Scale

| Stage  | Concurrent Users | Infrastructure         | Monthly Cost |
| ------ | ---------------- | ---------------------- | ------------ |
| MVP    | 500              | 1× c-4 + Redis         | $57          |
| Launch | 1,500            | 1× c-4 + Redis + LB    | $74          |
| Growth | 5,000            | 2× c-8 + Redis HA + LB | $230         |
| Scale  | 12,000           | 3× c-8 + Redis HA + LB | $450         |

---

## 11. Security

### Authentication Flow

1. Client provides Sanctum token on socket connect
2. Token checked against Redis revocation list
3. Token validated against Laravel API (with caching)
4. User data attached to socket for handler use

### Token Revocation

When users log out, add to Redis:

```
SET auth:revoked:{sha256(token)} 1 EX 86400
```

### Input Validation

All socket payloads validated with Zod schemas:

- UUIDs validated format
- Strings length-limited
- Numbers range-checked
- Unknown fields rejected

### Rate Limiting

| Action        | Limit | Window   |
| ------------- | ----- | -------- |
| Chat messages | 60    | 1 minute |
| Gift sending  | 30    | 1 minute |

### Internal API Security

All Laravel API calls include:

- `X-Internal-Key` header with shared secret
- 10-second timeout
- HTTPS transport

---

## 12. Monitoring & Health Checks

### Health Endpoint

**GET /health**

```json
{
  "status": "ok",
  "uptime": 3600.5,
  "redis": "up",
  "workers": {
    "count": 4,
    "healthy": true
  },
  "rooms": 15,
  "timestamp": "2024-01-15T12:00:00.000Z"
}
```

| Status     | HTTP Code | Meaning                    |
| ---------- | --------- | -------------------------- |
| `ok`       | 200       | All systems operational    |
| `degraded` | 503       | Redis or workers unhealthy |

### Metrics Endpoint

**GET /metrics**

```json
{
  "system": {
    "uptime": 3600.5,
    "memory": {
      "rss": 104857600,
      "heapTotal": 52428800,
      "heapUsed": 41943040,
      "external": 10485760
    },
    "cpu": { "user": 1000000, "system": 500000 },
    "loadAverage": [0.5, 0.6, 0.7],
    "freemem": 4294967296,
    "totalmem": 17179869184
  },
  "application": {
    "rooms": 15,
    "activeWorkers": 4,
    "concurrency": 4
  },
  "timestamp": "2024-01-15T12:00:00.000Z"
}
```

### Logging

Structured JSON logging via Pino:

```json
{
  "level": 30,
  "time": 1705320000000,
  "pid": 12345,
  "hostname": "audio-1",
  "msg": "Client authenticated",
  "socketId": "abc123",
  "userId": 42
}
```

Log levels:

- `fatal`: Application crash
- `error`: Operation failed
- `warn`: Recoverable issues
- `info`: Normal operations
- `debug`: Detailed debugging

---

## 13. Troubleshooting

### Common Issues

#### "Authentication required" on connect

**Cause**: Token not provided in socket auth  
**Fix**: Ensure `auth: { token }` is set in socket.io client options

#### "Invalid credentials" on connect

**Cause**: Token expired, invalid, or revoked  
**Fix**:

1. Check token validity in Laravel
2. Check Redis for `auth:revoked:{hash}` key
3. Verify `LARAVEL_INTERNAL_KEY` matches

#### No audio after consuming

**Cause**: Consumer not resumed (consumers start paused)  
**Fix**: Call `consumer:resume` after `audio:consume`

#### ICE connection failed

**Cause**: `MEDIASOUP_ANNOUNCED_IP` not set correctly  
**Fix**: Set to your server's public IP address

#### Workers not starting

**Cause**: Missing build dependencies for mediasoup  
**Fix**: Install `python3 make g++ linux-headers`

### Debug Mode

Enable verbose logging:

```env
LOG_LEVEL=debug
```

### Redis Debugging

```bash
# Check auth cache
redis-cli KEYS "auth:token:*"

# Check room state
redis-cli GET "room:state:{room_id}"

# Check gift queue size
redis-cli LLEN "gifts:pending"

# Monitor real-time
redis-cli MONITOR
```

### Health Check Failure

```bash
# Check manually
curl -v http://localhost:3030/health

# Check Redis connectivity
redis-cli -h $REDIS_HOST -p $REDIS_PORT PING

# Check Mediasoup workers
# Look for "Workers initialized" in logs
```

---

## Related Documentation

- [Frontend Integration Guide](./FRONTEND_INTEGRATION.md) — Complete Socket.IO event reference
- [Laravel Requirements](./LARAVEL_REQUIREMENTS.md) — Backend API specifications

---

## License

Proprietary - FlyLive

## Support

For issues and support, contact the engineering team.
