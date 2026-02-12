# Broadcast Event: `audio:newProducer`

> **Domain**: Media  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `audio:produce`

---

## 1. Event Overview

### Purpose

Notifies room members when a new audio producer is created (user started speaking). Clients use this to initiate `audio:consume` for the new producer.

### Key Characteristics

| Property     | Value                                 |
| ------------ | ------------------------------------- |
| Target       | All sockets in room (except producer) |
| Emitted From | `media.handler.ts` (audio:produce)    |
| Emitted Via  | `socket.to(roomId).emit()`            |

---

## 2. Event Payload

```typescript
{
  producerId: string,     // Producer UUID
  userId: number,         // User who started producing
  kind: "audio"           // Media kind
}
```

---

## 3. Document Metadata

| Property         | Value                                |
| ---------------- | ------------------------------------ |
| **Event**        | `audio:newProducer`                  |
| **Created**      | 2026-02-09                           |
| **Last Updated** | 2026-02-12                           |
| **Source**       | `src/domains/media/media.handler.ts` |

### Schema Change Log

| Date       | Change                                                            |
| ---------- | ----------------------------------------------------------------- |
| 2026-02-12 | Fixed field name: `producerUserId` → `userId`, added `kind` field |

---

_Documentation generated following [MSAB Broadcast Template](../../../BROADCAST_TEMPLATE.md)_
