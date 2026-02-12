# Event: `transport:create`

> **Domain**: Media  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `transport:connect`, `audio:produce`, `audio:consume`

---

## 1. Event Overview

### Purpose

Creates a WebRTC transport for either sending (producer) or receiving (consumer) audio. First step in establishing WebRTC media connections.

### Business Context

Each client needs a producer transport (to speak) and/or a consumer transport (to listen). This event creates the server-side transport and returns ICE/DTLS parameters for the client handshake.

### Key Characteristics

| Property                | Value                                                      |
| ----------------------- | ---------------------------------------------------------- |
| Requires Authentication | Yes (via middleware)                                       |
| Has Acknowledgment      | Yes (via createHandler)                                    |
| Broadcasts              | No                                                         |
| Transport Limit         | SEC-MED-001: max 2 transports per client (1 send + 1 recv) |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `transportCreateSchema`  
**Source**: `src/socket/schemas.ts`

```typescript
export const transportCreateSchema = z.object({
  type: z.enum(["producer", "consumer"]),
  roomId: roomIdSchema,
});
```

### 2.2 Acknowledgment (Success)

```typescript
{
  success: true,
  data: {
    id: string,                  // Transport UUID
    iceParameters: IceParameters,
    iceCandidates: IceCandidate[],
    dtlsParameters: DtlsParameters,
  }
}
```

### 2.3 Acknowledgment (Error)

```typescript
{
  success: false,
  error: "INVALID_PAYLOAD" | "Transport limit reached" | "Room not found" | "INTERNAL_ERROR"
}
```

---

## 3. Event Execution Flow

### 3.1 Entry Point

```typescript
const transportCreateHandler = createHandler(
  "transport:create",
  transportCreateSchema,
  async (payload, socket, context) => { ... }
);
```

### 3.2 Execution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. createHandler validates payload + room membership                        │
│ 2. SEC-MED-001: Check client.transports.size < 2 (limit reached → error)  │
│ 3. Look up room cluster via roomManager.getRoom(roomId)                    │
│ 4. Create WebRTC transport via cluster.createWebRtcTransport(isProducer)    │
│ 5. Track transport on client (client.transports.set(id, type))             │
│ 6. Return { success: true, data: { id, ice/dtls params } }                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### SEC-MED-001: Transport Limit

Clients are limited to 2 transports (1 producer + 1 consumer) to prevent resource abuse:

```typescript
const client = context.clientManager.getClient(socket.id);
if (client && client.transports.size >= 2) {
  return { success: false, error: "Transport limit reached" };
}
```

---

## 4. Document Metadata

| Property         | Value                                |
| ---------------- | ------------------------------------ |
| **Event**        | `transport:create`                   |
| **Domain**       | Media                                |
| **Direction**    | C→S                                  |
| **Created**      | 2026-02-09                           |
| **Last Updated** | 2026-02-12                           |
| **Handler**      | `src/domains/media/media.handler.ts` |

### Schema Change Log

| Date       | Change                                               |
| ---------- | ---------------------------------------------------- |
| 2026-02-12 | Handler migrated to `createHandler` pattern (CQ-001) |
| 2026-02-12 | Added SEC-MED-001 transport limit (max 2 per client) |
| 2026-02-12 | ACK response wrapped in `{ success, data }` envelope |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
