# Event: `audio:consume`

> **Domain**: Media  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `audio:produce`, `audio:newProducer` (trigger), `consumer:resume` (next step)

---

## 1. Event Overview

### Purpose

Creates a consumer to receive audio from a specific producer, enabling a client to listen to another user's audio stream.

### Business Context

When a speaker produces audio via `audio:produce`, listeners receive `audio:newProducer` and call this event to create a consumer. The consumer starts **paused** — the client must call `consumer:resume` after setting up local playback.

### Key Characteristics

| Property                | Value                                      |
| ----------------------- | ------------------------------------------ |
| Requires Authentication | Yes (via middleware)                       |
| Has Acknowledgment      | Yes (via createHandler)                    |
| Broadcasts              | No                                         |
| Consumer State          | Created paused (requires consumer:resume)  |
| Multi-Router            | Uses cluster.consume() for piped producers |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `audioConsumeSchema`  
**Source**: `src/socket/schemas.ts`

```typescript
export const audioConsumeSchema = z.object({
  roomId: roomIdSchema,
  transportId: z.string(),
  producerId: z.string(),
  rtpCapabilities: z.any(), // mediasoup RtpCapabilities
});
```

### 2.2 Acknowledgment (Success)

```typescript
{
  success: true,
  data: {
    id: string,              // Consumer UUID
    producerId: string,      // Producer being consumed
    kind: "audio",
    rtpParameters: RtpParameters
  }
}
```

### 2.3 Acknowledgment (Error)

```typescript
{
  success: false,
  error: "INVALID_PAYLOAD" | "Room not found" | "Cannot consume" | "INTERNAL_ERROR"
}
```

---

## 3. Event Execution Flow

### 3.1 Entry Point

```typescript
const audioConsumeHandler = createHandler(
  "audio:consume",
  audioConsumeSchema,
  async (payload, _socket, context) => { ... }
);
```

### 3.2 Execution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. createHandler validates payload + room membership                        │
│ 2. Look up room cluster via roomManager.getRoom(roomId)                    │
│ 3. Check codec compatibility via cluster.canConsume(producerId, rtpCaps)    │
│ 4. Create consumer via cluster.consume(transportId, producerId, rtpCaps)   │
│    → cluster resolves piped producer ID from distribution router            │
│ 5. Return { success: true, data: { id, producerId, kind, rtpParameters } } │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Multi-Router Cluster Piping

Unlike the old single-router approach, `cluster.consume()` resolves the correct piped producer ID on the distribution router where the consumer transport lives:

```typescript
const consumer = await cluster.consume(
  transportId,
  producerId,
  rtpCapabilities as mediasoup.types.RtpCapabilities,
);
```

---

## 4. Document Metadata

| Property         | Value                                |
| ---------------- | ------------------------------------ |
| **Event**        | `audio:consume`                      |
| **Domain**       | Media                                |
| **Direction**    | C→S                                  |
| **Created**      | 2026-02-09                           |
| **Last Updated** | 2026-02-12                           |
| **Handler**      | `src/domains/media/media.handler.ts` |

### Schema Change Log

| Date       | Change                                               |
| ---------- | ---------------------------------------------------- |
| 2026-02-12 | Handler migrated to `createHandler` pattern (CQ-001) |
| 2026-02-12 | Consume flow uses `cluster.consume()` (multi-router) |
| 2026-02-12 | `canConsume()` now called on cluster, not raw router |
| 2026-02-12 | ACK response wrapped in `{ success, data }` envelope |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
