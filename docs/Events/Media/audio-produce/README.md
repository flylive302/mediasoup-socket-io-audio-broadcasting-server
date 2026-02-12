# Event: `audio:produce`

> **Domain**: Media  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `transport:create`, `transport:connect`, `audio:newProducer` (S→C broadcast)

---

## 1. Event Overview

### Purpose

Starts producing (sending) audio through a connected producer transport. Creates a mediasoup Producer, registers it in the cluster (auto-pipes to distribution routers), and broadcasts `audio:newProducer` to other room members.

### Business Context

When a seated user wants to speak, their client creates a producer transport, connects it, then calls `audio:produce` to start sending audio. Other clients receive `audio:newProducer` and call `audio:consume` to listen.

### Key Characteristics

| Property                | Value                                            |
| ----------------------- | ------------------------------------------------ |
| Requires Authentication | Yes (via middleware)                             |
| Has Acknowledgment      | Yes (via createHandler)                          |
| Broadcasts              | `audio:newProducer` to room (via `socket.to()`)  |
| Modifies State          | Client speaker status, cluster producer registry |
| Guard                   | CQ-LOW-001: double-close guard on transportclose |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `audioProduceSchema`  
**Source**: `src/socket/schemas.ts`

```typescript
export const audioProduceSchema = z.object({
  roomId: roomIdSchema,
  transportId: z.string(),
  kind: z.enum(["audio"]),
  rtpParameters: rtpParametersSchema,
});
```

### 2.2 Acknowledgment (Success)

```typescript
{
  success: true,
  data: { id: string }  // Producer UUID
}
```

### 2.3 Acknowledgment (Error)

```typescript
{
  success: false,
  error: "INVALID_PAYLOAD" | "Transport not found" | "INTERNAL_ERROR"
}
```

### 2.4 Broadcast Event

**Event**: `audio:newProducer` (to room excluding sender, via `socket.to(roomId)`)

```typescript
{
  producerId: string,
  userId: number,
  kind: "audio"
}
```

---

## 3. Event Execution Flow

### 3.1 Entry Point

```typescript
const audioProduceHandler = createHandler(
  "audio:produce",
  audioProduceSchema,
  async (payload, socket, context) => { ... }
);
```

### 3.2 Execution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. createHandler validates payload + room membership                        │
│ 2. Look up cluster + transport                                              │
│ 3. Create mediasoup producer via transport.produce()                        │
│ 4. Track producer on client (client.producers.set(kind, producerId))       │
│ 5. Set client.isSpeaker = true                                              │
│ 6. Add producer to cluster audioObserver (active speaker detection)         │
│ 7. Register producer in cluster — auto-pipes to distribution routers       │
│    (MUST complete before notifying so piped producers exist)                │
│ 8. Broadcast audio:newProducer { producerId, userId, kind } to room        │
│ 9. Set up transportclose handler (CQ-LOW-001: guard double-close)          │
│ 10. Return { success: true, data: { id: producer.id } }                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Transport Close Cleanup (CQ-LOW-001)

```typescript
producer.on("transportclose", () => {
  if (client) {
    client.producers.delete(kind);
    client.isSpeaker = client.producers.size > 0;
  }
  if (!producer.closed) producer.close(); // Guard against double-close
});
```

---

## 4. Document Metadata

| Property         | Value                                |
| ---------------- | ------------------------------------ |
| **Event**        | `audio:produce`                      |
| **Domain**       | Media                                |
| **Direction**    | C→S                                  |
| **Created**      | 2026-02-09                           |
| **Last Updated** | 2026-02-12                           |
| **Handler**      | `src/domains/media/media.handler.ts` |

### Schema Change Log

| Date       | Change                                                |
| ---------- | ----------------------------------------------------- |
| 2026-02-12 | Handler migrated to `createHandler` pattern (CQ-001)  |
| 2026-02-12 | Added CQ-LOW-001 double-close guard on transportclose |
| 2026-02-12 | ACK response wrapped in `{ success, data }` envelope  |
| 2026-02-12 | Clarified piping order (register before broadcast)    |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
