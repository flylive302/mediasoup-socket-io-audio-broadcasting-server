# Broadcast Event: `seat:cleared`

> **Domain**: Seat  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `seat:leave`, `seat:remove`, `seat:lock` (kick), `room:leave`, disconnect

---

## 1. Event Overview

### Purpose

Notifies room when a seat becomes empty (user left, removed, kicked by lock, or disconnected).

### Key Characteristics

| Property     | Value                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| Target       | All sockets in room                                                                                             |
| Emitted From | `leave-seat.handler.ts`, `remove-seat.handler.ts`, `lock-seat.handler.ts`, `room.handler.ts`, `socket/index.ts` |
| Emitted Via  | `socket.to(roomId).emit()` or `socket.nsp.to(roomId).emit()`                                                    |

---

## 2. Event Payload

```typescript
{
  seatIndex: number; // 0-99
}
```

---

## 3. Document Metadata

| Property         | Value                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| **Event**        | `seat:cleared`                                                                                                  |
| **Created**      | 2026-02-09                                                                                                      |
| **Last Updated** | 2026-02-12                                                                                                      |
| **Sources**      | `leave-seat.handler.ts`, `remove-seat.handler.ts`, `lock-seat.handler.ts`, `room.handler.ts`, `socket/index.ts` |

### Schema Change Log

| Date       | Change                                          |
| ---------- | ----------------------------------------------- |
| 2026-02-12 | Added `room:leave` and disconnect as triggers   |
| 2026-02-12 | Fixed seatIndex range comment from 0-14 to 0-99 |
| 2026-02-12 | Updated handler source references               |

---

_Documentation generated following [MSAB Broadcast Template](../../../BROADCAST_TEMPLATE.md)_
