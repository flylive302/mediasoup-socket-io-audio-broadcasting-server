# Broadcast Event: `seat:updated`

> **Domain**: Seat  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `seat:take`, `seat:assign`, `seat:invite:accept`

---

## 1. Event Overview

### Purpose

Notifies room when a seat is taken by a user.

### Key Characteristics

| Property     | Value                                                                          |
| ------------ | ------------------------------------------------------------------------------ |
| Target       | All sockets in room                                                            |
| Emitted From | `take-seat.handler.ts`, `assign-seat.handler.ts`, `invite-response.handler.ts` |
| Emitted Via  | `socket.to(roomId).emit()` or `socket.nsp.to(roomId).emit()`                   |

---

## 2. Event Payload

```typescript
{
  seatIndex: number,    // 0-99
  userId: number,       // BL-007: userId only — frontend looks up user from participants
  isMuted: boolean
}
```

> [!IMPORTANT]
> BL-007 change: Previously sent a nested `user` object. Now sends flat `userId` only — frontend resolves from its local participants store.

---

## 3. Document Metadata

| Property         | Value                                                                          |
| ---------------- | ------------------------------------------------------------------------------ |
| **Event**        | `seat:updated`                                                                 |
| **Created**      | 2026-02-09                                                                     |
| **Last Updated** | 2026-02-12                                                                     |
| **Sources**      | `take-seat.handler.ts`, `assign-seat.handler.ts`, `invite-response.handler.ts` |

### Schema Change Log

| Date       | Change                                                            |
| ---------- | ----------------------------------------------------------------- |
| 2026-02-12 | BL-007: Payload changed from nested `user` object → flat `userId` |

---

_Documentation generated following [MSAB Broadcast Template](../../../BROADCAST_TEMPLATE.md)_
