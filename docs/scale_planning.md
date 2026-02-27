# FlyLive MSAB — Scale Planning: Mega-Rooms (10K-20K Listeners)

> **Sprint goal:** Understand the problem, choose the strategy, break into implementable work items. No code changes in this document — this is the blueprint for a future sprint.

---

## Current System Limits

| Metric | Per Instance | Per Room (single instance) |
|--------|-------------|---------------------------|
| Mediasoup workers | 3 (cores 1-3) | All 3 used via `pipeToRouter()` |
| Listeners per distribution router | 700 (`MAX_LISTENERS_PER_DISTRIBUTION_ROUTER`) | — |
| Max listeners per room | — | ~2,100 (700 × 3 workers) |
| Instance type | c7i.xlarge (4 vCPUs) | — |
| ASG max instances per region | 3 | — |

**The bottleneck:** A room lives in-memory on ONE instance. All listeners must connect to that instance. Beyond ~2,100 listeners, a single instance cannot handle the room.

---

## The Problem

```
Celebrity enters room
  → 20,000 listeners try to join
  → All must connect to the ONE instance hosting the room
  → Instance can only handle ~2,100
  → 17,900 users get degraded experience or connection failures
```

ASG scaling doesn't help here — it adds new instances for new rooms, but existing rooms can't migrate or split across instances.

---

## Two Strategies

### Strategy A: SFU Cascade (Recommended)

The CDN model applied to WebRTC. One "origin" holds the room, "edge" instances relay audio to listeners.

```
Speakers ──► Origin MSAB (source router + up to 2K listeners)
                │
                ├──► Edge MSAB 1 (plainTransport pipe, 2K listeners)
                ├──► Edge MSAB 2 (plainTransport pipe, 2K listeners)
                ├──► ...
                └──► Edge MSAB 10 (plainTransport pipe, 2K listeners)
                
Total capacity: ~22,000 listeners
```

**How it works:**
1. Origin MSAB creates a `plainTransport` for each producer (speaker)
2. Edge MSAB creates a `plainTransport` pointing to origin's IP:port
3. RTP flows from origin → edge via UDP (encrypted with SRTP)
4. Edge creates local `Router` + distribution routers for its listeners
5. Listeners on edges consume audio from local routers — they don't know about origin

**Key properties:**
- Sub-second latency preserved (pure WebRTC)
- Speakers always connect to origin
- Listeners connect to least-loaded edge (or origin if capacity available)
- Adding an edge = adding ~2K listener capacity
- Origin bandwidth: ~50kbps × num_edges ≈ 500kbps for 10 edges (trivial)

**New components needed:**
| Component | Purpose |
|-----------|---------|
| **Room Registry** | Redis-backed. Tracks: which instance is origin, which are edges, current listener counts |
| **Pipe Manager** | Manages `plainTransport` creation/teardown between origin and edges |
| **Routing Service** | Decides where to send a new listener (origin or which edge) |
| **Internal API** | HTTP endpoints on MSAB for pipe negotiation between instances |

### Strategy B: HLS Fallback (Simpler, Higher Latency)

When a room exceeds threshold, overflow listeners get a low-latency HLS stream instead of WebRTC.

```
Speakers ──► MSAB (WebRTC, up to 2K direct listeners)
               │
               └──► FFmpeg sidecar ──► S3/CloudFront ──► HLS Listeners (unlimited)
                    (transcoding)       (CDN)            (3-5s latency)
```

**Pros:** Proven at massive scale, simpler MSAB changes, CloudFront handles distribution
**Cons:** 3-5 second latency for HLS listeners, need FFmpeg/MediaLive, need frontend HLS player

---

## Recommendation: Two-Tier Architecture

> [!IMPORTANT]
> Use **Strategy A (SFU Cascade)** as the primary approach, with **Strategy B (HLS)** as an optional future fallback for truly extreme scale (50K+).

Rationale:
- Your app is **audio chat**, not broadcast TV — users expect low latency
- SFU cascade keeps sub-second latency for all 20K listeners
- HLS adds infrastructure complexity (transcoding, CDN) for a worse experience
- SFU cascade can be built entirely within the existing MSAB codebase

---

## SFU Cascade — Detailed Design

### 1. Room Registry (Redis)

```
room:{roomId}:origin     → { instanceId, ip, port }
room:{roomId}:edges      → [{ instanceId, ip, port, listenerCount }]
room:{roomId}:capacity   → { current: 3500, max: 22000 }
```

When a user joins:
1. Check registry: is this room at capacity on origin?
2. If yes, find least-loaded edge (or spawn new edge via ASG)
3. Return the correct MSAB endpoint to the frontend
4. Frontend connects to that specific instance

### 2. Internal Pipe API (new HTTP endpoints on MSAB)

```
POST /internal/pipe/offer
  Body: { roomId, producerId, originIp, originPort }
  Response: { edgeIp, edgePort, srtpParameters }

POST /internal/pipe/close
  Body: { roomId }
```

These are instance-to-instance calls, not exposed externally. Authenticated by `X-Internal-Key`.

### 3. Origin MSAB Flow

```typescript
// When room exceeds threshold (e.g., 1,800 listeners):
// 1. Register as origin in Redis
// 2. Create plainTransport for each active producer
// 3. Wait for edge instances to connect

const transport = await router.createPlainTransport({
  listenIp: { ip: '0.0.0.0', announcedIp: PUBLIC_IP },
  rtcpMux: true,
  comedia: false,
});
// Store transport.tuple → { ip, port } in Redis for edges to connect
```

### 4. Edge MSAB Flow

```typescript
// 1. Get origin's transport info from Redis
// 2. Create local plainTransport pointing to origin
// 3. Create local router
// 4. pipe the incoming RTP into the local router
// 5. Create distribution routers for listeners (same as current RoomMediaCluster)

const transport = await router.createPlainTransport({
  listenIp: { ip: '0.0.0.0', announcedIp: PUBLIC_IP },
  rtcpMux: true,
  comedia: true, // Origin sends first, edge receives
});
await transport.connect({
  ip: originInfo.ip,
  port: originInfo.port,
});
```

### 5. Frontend Changes

The room join API response would include a `connect_to` field when the room is at capacity:

```json
// Laravel room detail response (enhanced)
{
  "id": 42,
  "hosting_region": "ap-south-1",
  "hosting_endpoint": "wss://mumbai.audio.flyliveapp.com",  // origin
  "overflow_endpoint": "wss://mumbai-edge-2.audio.flyliveapp.com",  // if overflow
  ...
}
```

OR simpler: the routing decision happens server-side. User always connects to the origin, and if it's at capacity, the origin redirects the socket to an edge.

### 6. ASG Changes

**Capacity-based scaling (not just connection count):**

| Trigger | Action |
|---------|--------|
| Room listener count > 1,800 | Add edge instance if below max |
| Edge listener count < 200 for 10min | Remove edge, re-route listeners |
| All edges >80% capacity | Add another edge |

Need a new CloudWatch metric: `RoomListenerCount` per room.

---

## Security Considerations

- **Internal pipe traffic**: SRTP encrypted (mediasoup default for plainTransport)
- **Internal API**: Authenticated via `X-Internal-Key` (same as Laravel)
- **Security groups**: Allow UDP between MSAB instances (port range for pipes)
- **No user data in pipe**: Only RTP media packets flow between instances

---

## Capacity Planning

| Scenario | Origin | Edges | Total Listeners | Instances |
|----------|--------|-------|----------------|-----------|
| Small room | 1 | 0 | ≤ 2,100 | 1 |
| Medium room | 1 | 2 | ≤ 6,300 | 3 |
| Celebrity room | 1 | 5 | ≤ 12,600 | 6 |
| Mega event | 1 | 10 | ≤ 23,100 | 11 |

**Cost:** c7i.xlarge ≈ $0.17/hr. A 20K mega event with 11 instances = ~$1.87/hr. Tiny.

---

## Implementation Roadmap

### Phase 5A: Foundation (1 sprint)
- [ ] Room Registry service (Redis-backed)
- [ ] Internal pipe API (`/internal/pipe/offer`, `/internal/pipe/close`)
- [ ] `PipeManager` class in MSAB
- [ ] Security group update: allow inter-instance UDP
- [ ] New CloudWatch metric: `RoomListenerCount`

### Phase 5B: Cascade Logic (1 sprint)
- [ ] Origin auto-detection (first instance to create room)
- [ ] Edge provisioning (create pipe when threshold exceeded)
- [ ] Listener routing (direct new joiners to edges)
- [ ] Producer sync (when new speaker starts, pipe to all edges)
- [ ] Producer removal (when speaker stops, clean up pipes)

### Phase 5C: Resilience (1 sprint)
- [ ] Edge failure handling (re-route listeners if edge dies)
- [ ] Origin failover (promote edge to origin if origin dies)
- [ ] Graceful drain for edges (ASG termination lifecycle hook)
- [ ] Load testing: simulate 10K, 15K, 20K listeners

### Phase 5D (Optional): HLS Fallback
- [ ] FFmpeg sidecar for RTMP output
- [ ] AWS MediaLive or CloudFront for HLS distribution
- [ ] Frontend HLS player for 50K+ scenarios

---

## Dependencies and Blockers

| Dependency | Required For | Status |
|------------|-------------|--------|
| Phase 4 (region-aware routing) | Listener knows which endpoint to connect to | In progress |
| ASG max_instances increase | >3 instances per region for mega rooms | Config change |
| Security group inter-instance UDP | Pipe transport between instances | Terraform |
| Redis capacity | Room registry under high write load | Monitor |

---

## Key Risks

| Risk | Mitigation |
|------|-----------|
| Origin instance failure kills entire room | Phase 5C: origin failover to edge |
| Edge scaling too slow for spike | Pre-warm edge instances for known events (scheduled celebrity rooms) |
| plainTransport UDP blocked by security groups | Test before launch with 2-instance pipe |
| Redis registry becomes bottleneck | Registry writes are per-room (not per-listener), ~100 writes/sec max |

---

## Next Steps

1. ✅ Complete Phase 4 (region-aware routing) — **current sprint**
2. 📋 This document reviewed and approved
3. 🔨 Phase 5A: Room Registry + Internal Pipe API — **next sprint**
4. 🔨 Phase 5B: Cascade logic — **sprint after**
5. 🧪 Load test with simulated 10K listeners
