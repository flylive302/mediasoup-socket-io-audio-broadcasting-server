# Phase 5: SFU Cascade — Implementation Plan

> **Strategic context:** See [scale_planning.md](file:///home/xha/.gemini/antigravity/brain/fd9b9225-72e0-4243-93de-44df4163fb54/scale_planning.md) for the full rationale, capacity planning, and architecture diagrams.

## Goal

Scale individual rooms from ~2,100 listeners (single instance) to 20,000+ listeners using SFU cascade: one origin MSAB holds the room, edge MSAB instances relay audio via `plainTransport` pipes.

## Current Architecture (Key Files)

| File | Role | Lines |
|------|------|-------|
| [roomManager.ts](file:///home/xha/FlyLive/mediasoup-socket-io-audio-broadcasting-server/src/domains/room/roomManager.ts) | Room lifecycle (create, close, worker death) | 204 |
| [roomMediaCluster.ts](file:///home/xha/FlyLive/mediasoup-socket-io-audio-broadcasting-server/src/domains/media/roomMediaCluster.ts) | Multi-router media: source router → distribution routers via `pipeToRouter()` | 541 |
| [routerManager.ts](file:///home/xha/FlyLive/mediasoup-socket-io-audio-broadcasting-server/src/domains/media/routerManager.ts) | Wraps mediasoup Router with transport/producer/consumer tracking | — |
| [roomState.ts](file:///home/xha/FlyLive/mediasoup-socket-io-audio-broadcasting-server/src/domains/room/roomState.ts) | Redis-backed room state (participant count, status) | — |
| [cloudwatch.ts](file:///home/xha/FlyLive/mediasoup-socket-io-audio-broadcasting-server/src/infrastructure/cloudwatch.ts) | Publishes `ActiveRooms`, `ActiveConnections`, `WorkerCount`, `WorkerCPU` to `FlyLive/MSAB` namespace | 200 |
| [room.handler.ts](file:///home/xha/FlyLive/mediasoup-socket-io-audio-broadcasting-server/src/domains/room/room.handler.ts) | Socket handler for `room:join`, `room:leave` | — |

### Key Constants

- `MAX_LISTENERS_PER_DISTRIBUTION_ROUTER = 700` (in roomMediaCluster.ts)
- Workers: 3 per instance (cores 1-3), set in `worker.manager.ts`
- Max listeners per instance: ~2,100 (700 × 3)
- Instance type: c7i.xlarge (4 vCPUs)

---

## Phase 5A: Foundation (1 sprint)

### 5A-1: Room Registry Service

#### [NEW] `src/domains/room/room-registry.ts`

Redis-backed registry tracking origin/edge topology per room.

```typescript
// Redis key schema:
// room:{roomId}:origin    → JSON { instanceId, ip, port, listenerCount }
// room:{roomId}:edges     → Hash { [instanceId]: JSON { ip, port, listenerCount } }
// room:{roomId}:threshold → number (when to spawn edges, default 1800)

export class RoomRegistry {
  constructor(private readonly redis: Redis, private readonly logger: Logger) {}

  // Called when a room is created — registers this instance as origin
  async registerOrigin(roomId: string, instanceInfo: InstanceInfo): Promise<void>

  // Called when an edge is provisioned for a room
  async registerEdge(roomId: string, edgeInfo: InstanceInfo): Promise<void>

  // Remove edge (when draining or edge fails)
  async removeEdge(roomId: string, instanceId: string): Promise<void>

  // Get origin info (for edges to connect pipes)
  async getOrigin(roomId: string): Promise<InstanceInfo | null>

  // Get all edges with listener counts (for routing decisions)
  async getEdges(roomId: string): Promise<EdgeInfo[]>

  // Update listener count for an instance (origin or edge)
  async updateListenerCount(roomId: string, instanceId: string, delta: number): Promise<number>

  // Get total listener count across origin + all edges
  async getTotalListeners(roomId: string): Promise<number>

  // Find least-loaded instance (origin or edge) for a new listener
  async findBestInstance(roomId: string): Promise<InstanceInfo>

  // Clean up entire room from registry
  async cleanup(roomId: string): Promise<void>
}
```

### 5A-2: Internal Pipe API

#### [NEW] `src/api/internal.ts`

HTTP endpoints for instance-to-instance communication. Registered on the existing Fastify server.

```typescript
// POST /internal/pipe/offer
// Called by edge → origin to request a pipe for a producer
// Body: { roomId, producerId }
// Response: { transportIp, transportPort, srtpParameters, rtpParameters }

// POST /internal/pipe/close
// Called when edge disconnects
// Body: { roomId, instanceId }

// GET /internal/health
// Returns instance role (origin/edge/idle), room count, listener count

// Security: X-Internal-Key header (shared secret from env)
```

### 5A-3: Pipe Manager

#### [NEW] `src/domains/media/pipe-manager.ts`

Manages `plainTransport` creation/teardown for origin↔edge pipes.

```typescript
export class PipeManager {
  constructor(
    private readonly workerManager: WorkerManager,
    private readonly logger: Logger,
  ) {}

  // ORIGIN: Create a plainTransport for a producer (called per-producer, per-edge)
  async createOriginPipe(
    router: mediasoup.types.Router,
    producerId: string,
  ): Promise<PlainTransportInfo>

  // EDGE: Create a plainTransport pointing to origin + produce locally
  async createEdgePipe(
    router: mediasoup.types.Router,
    originTransportInfo: PlainTransportInfo,
    rtpParameters: mediasoup.types.RtpParameters,
  ): Promise<{ transport: mediasoup.types.PlainTransport; producer: mediasoup.types.Producer }>

  // Close all pipes for a room
  async closePipes(roomId: string): Promise<void>
}
```

### 5A-4: Terraform — Security Groups

#### [MODIFY] `terraform/modules/networking/main.tf`

Add ingress rule allowing UDP between MSAB instances (for plainTransport RTP):

```hcl
# Allow inter-instance UDP for SFU cascade pipes
ingress {
  from_port   = 40000
  to_port     = 49999
  protocol    = "udp"
  self        = true  # Same security group
  description = "SFU cascade plainTransport (RTP/SRTP)"
}
```

### 5A-5: New CloudWatch Metric

#### [MODIFY] `src/infrastructure/cloudwatch.ts`

Add `RoomListenerCount` metric (max listeners in any single room):

```typescript
{
  MetricName: "MaxRoomListeners",
  Value: maxListenersInAnyRoom,
  Unit: "Count",
  ...
}
```

---

## Phase 5B: Cascade Logic (1 sprint)

### 5B-1: Origin Auto-Detection

#### [MODIFY] `src/domains/room/roomManager.ts`

In `doCreateRoom()`, register as origin in RoomRegistry:

```typescript
// After cluster.initialize():
await this.roomRegistry.registerOrigin(roomId, {
  instanceId: this.instanceId,
  ip: config.PUBLIC_IP,
  port: cluster.getPlainTransportPort(),
  listenerCount: 0,
});
```

### 5B-2: Threshold Detection + Edge Provisioning

#### [NEW] `src/domains/room/cascade-controller.ts`

Monitors room listener counts and triggers edge provisioning:

```typescript
export class CascadeController {
  // Called after every room:join — checks if this room needs edges
  async onListenerJoined(roomId: string): Promise<void>

  // Called after room:leave — checks if edges can be released
  async onListenerLeft(roomId: string): Promise<void>

  // Provision a new edge for a room (POST to edge instance's internal API)
  private async provisionEdge(roomId: string): Promise<void>

  // Release an underutilized edge
  private async releaseEdge(roomId: string, edgeInstanceId: string): Promise<void>
}
```

### 5B-3: Listener Routing

#### [MODIFY] `src/domains/room/room.handler.ts`

In `room:join` handler, before creating transport:

```typescript
// 1. Check if this instance is origin or edge for this room
// 2. If neither, check registry for best instance
// 3. If best instance is NOT this one, redirect:
//    socket.emit('room:redirect', { endpoint: 'wss://mumbai-edge-1.audio...' })
//    return
// 4. Otherwise, proceed with normal join flow
```

### 5B-4: Producer Sync

#### [MODIFY] `src/domains/media/roomMediaCluster.ts`

In `registerProducer()`, also create origin pipes for all connected edges:

```typescript
// After piping to distribution routers:
if (this.isOrigin) {
  for (const edge of this.connectedEdges) {
    await this.pipeManager.createOriginPipe(this.sourceRouter, producer.id);
    // Notify edge via internal API to create its side of the pipe
  }
}
```

---

## Phase 5C: Resilience (1 sprint)

### 5C-1: Edge Failure Handling
- **Detection:** Heartbeat via Redis (edge writes TTL key every 5s)
- **Recovery:** Origin detects missing heartbeat, removes edge from registry, logs event
- **Listeners:** Disconnected by Socket.IO auto-reconnect → re-routed to another edge

### 5C-2: Origin Failover
- **Detection:** Same heartbeat mechanism
- **Recovery:** Promote highest-capacity edge to origin
- **Scope:** Complex — defer to 5C if time permits

### 5C-3: Graceful Edge Drain
- **Trigger:** ASG termination lifecycle hook (already exists)
- **Flow:** Mark edge as draining → stop accepting new listeners → existing listeners finish → close pipes → terminate

### 5C-4: Load Testing
- Script to simulate 10K, 15K, 20K WebSocket connections to a single room
- Measure: latency, CPU, memory, pipe bandwidth
- Tool: `artillery` or custom Node.js script with `socket.io-client`

---

## Config Changes Needed

#### [MODIFY] `src/config/index.ts`

```typescript
CASCADE_ENABLED: boolean     // Feature flag, default false
CASCADE_THRESHOLD: number    // Listeners before spawning edge, default 1800
INTERNAL_API_KEY: string     // Shared secret for instance-to-instance auth
PUBLIC_IP: string            // This instance's public IP (from IMDS or env)
```

---

## Dependencies

| Dependency | Status | Blocker? |
|------------|--------|----------|
| Phase 4 (region routing) | ✅ Complete | No |
| ASG `max_size` increase | Config change in Terraform | No |
| Security group UDP rule | Phase 5A-4 | No |
| `@aws-sdk/client-cloudwatch` | Already installed | No |
| Frontend: handle `room:redirect` event | Requires frontend team update | Yes (5B-3) |

## Frontend Team Requirements (for Phase 5B)

The frontend needs to handle one new socket event:

```typescript
// When the room is at capacity, MSAB redirects to an edge:
socket.on('room:redirect', ({ endpoint }) => {
  // endpoint = 'wss://mumbai.audio.flyliveapp.com' (could be same or different)
  // Reconnect to the given endpoint and re-join the room
  await connect(endpoint);
  await joinRoom(roomId);
});
```

---

## Execution Order

```
5A-1 → 5A-2 → 5A-3 → 5A-4 → 5A-5  (all independent, can parallelize)
         ↓
5B-1 → 5B-2 → 5B-3 → 5B-4  (sequential, each builds on previous)
         ↓
5C-1 → 5C-2 → 5C-3 → 5C-4  (mostly independent)
```

## Verification Plan

| Test | Expected Result |
|------|----------------|
| Create room on instance A | Registry shows A as origin |
| 1800 listeners join | CascadeController provisions edge B |
| Listener 1801 joins | Routed to edge B, hears all speakers |
| Speaker starts on origin | Pipe created, edge B listeners hear audio |
| Edge B killed | Listeners reconnect, routed to new edge C |
| Room closes | All pipes closed, registry cleaned up |
