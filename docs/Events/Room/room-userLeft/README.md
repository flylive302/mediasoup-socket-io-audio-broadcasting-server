# Broadcast Event: `room:userLeft`

> **Domain**: Room  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `room:leave` handler, disconnect cleanup

---

## 1. Event Overview

### Purpose

Notifies all room members when a user leaves the room (explicitly or via disconnect).

### Key Characteristics

| Property     | Value                                             |
| ------------ | ------------------------------------------------- |
| Target       | All sockets in room                               |
| Emitted From | `room.handler.ts`, `socket/index.ts` (disconnect) |
| Emitted Via  | `socket.to(roomId).emit()`                        |

---

## 2. Event Payload

```typescript
{
  userId: number;
}
```

---

## 3. Document Metadata

| Property         | Value                                                     |
| ---------------- | --------------------------------------------------------- |
| **Event**        | `room:userLeft`                                           |
| **Created**      | 2026-02-09                                                |
| **Last Updated** | 2026-02-12                                                |
| **Sources**      | `src/domains/room/room.handler.ts`, `src/socket/index.ts` |

### Schema Change Log

| Date       | Change                    |
| ---------- | ------------------------- |
| 2026-02-12 | Updated source references |

---

_Documentation generated following [MSAB Broadcast Template](../../../BROADCAST_TEMPLATE.md)_
