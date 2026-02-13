# Broadcast Event: `room:closed`

> **Domain**: Room  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `RoomManager.closeRoom()` (host left, worker died, auto-close)

---

## 1. Event Overview

### Purpose

Notifies all room members when a room is being closed and cleaned up.

### Key Characteristics

| Property     | Value                            |
| ------------ | -------------------------------- |
| Target       | All sockets in room              |
| Emitted From | `roomManager.ts` (`closeRoom()`) |
| Emitted Via  | `this.io.to(roomId).emit()`      |

---

## 2. Event Payload

```typescript
{
  roomId: string,
  reason: string,        // "host_left" | "worker_died" | "auto_close"
  timestamp: number      // Date.now()
}
```

---

## 3. Document Metadata

| Property         | Value                             |
| ---------------- | --------------------------------- |
| **Event**        | `room:closed`                     |
| **Created**      | 2026-02-09                        |
| **Last Updated** | 2026-02-12                        |
| **Source**       | `src/domains/room/roomManager.ts` |

### Schema Change Log

| Date       | Change                                                        |
| ---------- | ------------------------------------------------------------- |
| 2026-02-12 | Fixed payload: `{ reason }` → `{ roomId, reason, timestamp }` |

---

_Documentation generated following [MSAB Broadcast Template](../../../BROADCAST_TEMPLATE.md)_
