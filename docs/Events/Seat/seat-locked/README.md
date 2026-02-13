# Broadcast Event: `seat:locked`

> **Domain**: Seat  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `seat:lock`, `seat:unlock`, `seat:invite:accept`

---

## 1. Event Overview

### Purpose

Notifies room when a seat is locked or unlocked.

### Key Characteristics

| Property     | Value                                                                          |
| ------------ | ------------------------------------------------------------------------------ |
| Target       | All sockets in room                                                            |
| Emitted From | `lock-seat.handler.ts`, `unlock-seat.handler.ts`, `invite-response.handler.ts` |
| Emitted Via  | `socket.nsp.to(roomId).emit()`                                                 |

---

## 2. Event Payload

```typescript
{
  seatIndex: number,      // 0-99
  isLocked: boolean       // true = locked, false = unlocked
}
```

> [!NOTE]
> Both lock and unlock emit the same event name `seat:locked` — differentiated by the `isLocked` boolean.

---

## 3. Document Metadata

| Property         | Value                                                                          |
| ---------------- | ------------------------------------------------------------------------------ |
| **Event**        | `seat:locked`                                                                  |
| **Created**      | 2026-02-09                                                                     |
| **Last Updated** | 2026-02-12                                                                     |
| **Sources**      | `lock-seat.handler.ts`, `unlock-seat.handler.ts`, `invite-response.handler.ts` |

### Schema Change Log

| Date       | Change                    |
| ---------- | ------------------------- |
| 2026-02-12 | Updated source references |

---

_Documentation generated following [MSAB Broadcast Template](../../../BROADCAST_TEMPLATE.md)_
