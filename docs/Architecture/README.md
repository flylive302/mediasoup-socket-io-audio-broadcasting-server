# MSAB Architecture Overview

> **Version**: 1.1  
> **Last Updated**: 2026-02-10  
> **Service**: FlyLive Audio Server (MSAB)

---

## System Identity

**FlyLive Audio Server (MSAB)** is a production-grade, horizontally scalable, audio-only conferencing backend serving as the **realtime subsystem** within the FlyLive platform.

### Technology Stack

| Layer          | Technology      | Version |
| -------------- | --------------- | ------- |
| **Runtime**    | Node.js (ESM)   | ≥22.0.0 |
| **Language**   | TypeScript      | ^5.7.0  |
| **HTTP**       | Fastify         | ^5.0.0  |
| **Realtime**   | Socket.IO       | ^4.8.1  |
| **Media**      | mediasoup SFU   | ^3.15.7 |
| **State**      | Redis (ioredis) | ^5.4.1  |
| **Validation** | Zod             | ^3.24.0 |
| **Logging**    | Pino            | ^9.5.0  |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           NUXT FRONTEND                                     │
│    mediasoup-client + socket.io-client + Vue Components                     │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │ WebSocket + WebRTC
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     MSAB (This Repository)                                  │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                    Fastify HTTP Server                              │   │
│   │              /health  /metrics (Prometheus)                         │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                 │                                           │
│   ┌─────────────────────────────▼───────────────────────────────────────┐   │
│   │                    Socket.IO Server                                 │   │
│   │                 (Redis Adapter for scaling)                         │   │
│   │                                                                     │   │
│   │   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │   │
│   │   │ Room     │ │ Media    │ │ Seat     │ │ Chat     │ │ Gift     │ │   │
│   │   │ Handler  │ │ Handler  │ │ Handler  │ │ Handler  │ │ Handler  │ │   │
│   │   └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                 │                                           │
│   ┌─────────────────────────────▼───────────────────────────────────────┐   │
│   │                    Shared Services                                  │   │
│   │   WorkerManager  │ RoomManager   │ ClientManager │ SeatRepository  │   │
│   │   RouterManager  │ GiftBuffer    │ RateLimiter   │ AutoCloseService│   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                    │                              │                         │
│   ┌────────────────▼─────┐           ┌───────────▼─────────────┐           │
│   │   Mediasoup Workers  │           │        Redis            │           │
│   │   (1 per CPU core)   │           │   (State + Pub/Sub)     │           │
│   └──────────────────────┘           └─────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
                                         │
                          ┌──────────────┴──────────────┐
                          │ HTTP (Internal API)         │ Redis Pub/Sub
                          ▼                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          LARAVEL BACKEND                                    │
│                                                                             │
│   HTTP Endpoints (MSAB → Laravel):                                          │
│   • POST /api/v1/internal/gifts/batch         → Gift processing            │
│   • POST /api/v1/internal/rooms/{id}/status   → Room status updates        │
│   • GET  /api/v1/internal/rooms/{id}          → Room data                  │
│                                                                             │
│   Redis Pub/Sub (Laravel → MSAB):                                           │
│   • Channel: flylive:msab:events              → Real-time event delivery   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### AppContext (Dependency Container)

```typescript
interface AppContext {
  io: Server; // Socket.IO server instance
  redis: Redis; // Redis client
  workerManager: WorkerManager; // Mediasoup worker pool
  roomManager: RoomManager; // Room lifecycle
  clientManager: ClientManager; // Socket tracking
  rateLimiter: RateLimiter; // Redis-backed rate limiting
  giftHandler: GiftHandler; // Gift processing
  laravelClient: LaravelClient; // HTTP client to Laravel
  autoCloseService: AutoCloseService; // Room inactivity tracking
  autoCloseJob: AutoCloseJob; // Room cleanup job
  seatRepository: SeatRepository; // Redis-backed seat state
  userSocketRepository: UserSocketRepository; // User↔Socket mapping
  eventSubscriber: LaravelEventSubscriber; // Redis pub/sub listener
}
```

### Domain Registry Pattern

```typescript
// src/domains/index.ts
export const domains: DomainRegistration[] = [
  registerSeatHandlers, // 10 seat events
  roomHandler, // room:join, room:leave
  mediaHandler, // transport/produce/consume
  chatHandler, // chat:message
  userHandler, // user:getRoom
];
```

---

## Socket.IO Events

### Client → Server (C→S)

| Domain | Event                                               | Purpose                         |
| ------ | --------------------------------------------------- | ------------------------------- |
| Room   | `room:join`                                         | Join room, get RTP capabilities |
| Room   | `room:leave`                                        | Leave room                      |
| Media  | `transport:create`                                  | Create WebRTC transport         |
| Media  | `transport:connect`                                 | DTLS handshake                  |
| Media  | `audio:produce`                                     | Start sending audio             |
| Media  | `audio:consume`                                     | Start receiving audio           |
| Media  | `consumer:resume`                                   | Unmute consumer                 |
| Seat   | `seat:take`                                         | Request seat                    |
| Seat   | `seat:leave`                                        | Leave seat                      |
| Seat   | `seat:assign/remove/mute/unmute/lock/unlock/invite` | Seat management                 |
| Chat   | `chat:message`                                      | Send message                    |
| Gift   | `gift:send`                                         | Send gift                       |
| Gift   | `gift:prepare`                                      | Preload signal                  |
| User   | `user:getRoom`                                      | Track user location             |

### Server → Client (S→C)

| Domain | Event               | Purpose                  |
| ------ | ------------------- | ------------------------ |
| Room   | `room:userJoined`   | User joined notification |
| Room   | `room:userLeft`     | User left notification   |
| Room   | `room:closed`       | Room ended               |
| Media  | `audio:newProducer` | Someone started audio    |
| Media  | `speaker:active`    | Active speaker changed   |
| Seat   | `seat:updated`      | Seat state changed       |
| Seat   | `seat:cleared`      | Seat vacated             |
| Chat   | `chat:message`      | Message received         |
| Gift   | `gift:received`     | Gift animation trigger   |

---

## Data Flow: Authentication

```
CLIENT                    MSAB                      REDIS
   │  WebSocket Connect     │                          │
   │  (JWT in auth.token)   │                          │
   │───────────────────────▶│                          │
   │                        │ 1. Verify HMAC-SHA256    │
   │                        │    signature (CPU-only)  │
   │                        │ 2. Check exp claim       │
   │                        │ 3. Validate payload (Zod)│
   │                        │ 4. Check Redis revocation│
   │                        │──────────────────────────▶│
   │                        │◀──────────────────────────│
   │  Connection OK         │ 5. Attach user to socket │
   │◀───────────────────────│                          │
```

> **Note**: Auth uses local JWT verification (HMAC-SHA256) with a shared secret.
> No HTTP round-trip to Laravel is required. User data is embedded in the JWT payload.
> See [JWT Migration Guide — Backend](../guides/jwt-migration-backend.md) for details.

---

## Data Flow: Audio Pipeline

```
SPEAKER                   MSAB                      LISTENER
   │  room:join             │                          │
   │───────────────────────▶│  rtpCapabilities         │
   │◀───────────────────────│                          │
   │  transport:create      │                          │
   │───────────────────────▶│  transport params        │
   │◀───────────────────────│                          │
   │  transport:connect     │                          │
   │───────────────────────▶│                          │
   │  audio:produce         │                          │
   │───────────────────────▶│  producerId              │
   │◀───────────────────────│                          │
   │                        │  audio:newProducer       │
   │                        │─────────────────────────▶│
   │                        │  transport:create        │
   │                        │◀─────────────────────────│
   │                        │  audio:consume           │
   │                        │◀─────────────────────────│
   │  RTP Audio ═══════════════════════════════════════▶
```

---

## Directory Structure

```
src/
├── index.ts              # Entry point
├── context.ts            # AppContext interface
├── auth/                 # JWT authentication (HMAC-SHA256)
├── client/               # Client tracking
├── config/               # Zod-validated config
├── domains/              # Domain handlers
│   ├── chat/             # Chat messaging
│   ├── gift/             # Gift transactions
│   ├── media/            # WebRTC transport
│   ├── room/             # Room lifecycle
│   ├── seat/             # Seat management
│   └── user/             # User features
├── infrastructure/       # Core services
├── integrations/         # Laravel integration
├── shared/               # Shared utilities
├── socket/               # Socket.IO setup
└── utils/                # Utilities
```

---

## Configuration

Key environment variables:

| Variable                 | Required | Purpose                            |
| ------------------------ | -------- | ---------------------------------- |
| `JWT_SECRET`             | ✅       | Shared HMAC secret (32+ chars)     |
| `LARAVEL_API_URL`        | ✅       | Laravel base URL                   |
| `LARAVEL_INTERNAL_KEY`   | ✅       | 32+ char secret                    |
| `MEDIASOUP_ANNOUNCED_IP` | ✅ Prod  | Public IP for WebRTC               |
| `REDIS_HOST`             | ✅ Prod  | Valkey/Redis host (dev: 127.0.0.1) |
| `REDIS_PORT`             | ✅ Prod  | Valkey/Redis port (dev: 6379)      |
| `REDIS_PASSWORD`         | ✅ Prod  | Valkey/Redis password              |
| `REDIS_TLS`              | ✅ Prod  | Enable TLS (`true` in production)  |
| `PORT`                   | ❌       | Default: 3030                      |
| `JWT_MAX_AGE_SECONDS`    | ❌       | Default: 86400 (24h)               |
| `LARAVEL_API_TIMEOUT_MS` | ❌       | Default: 10000 (10s)               |

> **Production Redis**: MSAB uses **DigitalOcean Managed Valkey** (Redis-compatible) in production
> with TLS, authentication, and DB index 3 (separate from Laravel). The deploy script
> (`scripts/deploy/deploy-droplet.sh`) auto-provisions these values from the Valkey cluster.
> Defaults (127.0.0.1:6379, no auth) are for local development only.

See `src/config/index.ts` for complete schema.

---

## References

- [Event Documentation](../Events/) - Individual event docs
- [Laravel Integration](../Integration/LARAVEL_API.md) - HTTP API contracts
- [Frontend Guide](../Integration/NUXT_CLIENT.md) - Client integration
