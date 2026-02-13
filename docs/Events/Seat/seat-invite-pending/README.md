# Broadcast Event: `seat:invite:pending`

> **Domain**: Seat  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `seat:invite`, `seat:invite:accept`, `seat:invite:decline`

---

## 1. Event Overview

### Purpose

Notifies room about seat invitation status (pending or cleared).

### Key Characteristics

| Property     | Value                                                        |
| ------------ | ------------------------------------------------------------ |
| Target       | All sockets in room                                          |
| Emitted From | `invite-seat.handler.ts`, `invite-response.handler.ts`       |
| Emitted Via  | `socket.to(roomId).emit()` or `socket.nsp.to(roomId).emit()` |

---

## 2. Event Payload

```typescript
{
  seatIndex: number,
  isPending: boolean,
  invitedUserId?: number   // Only when isPending = true
}
```

---

## 3. Document Metadata

| Property         | Value                                                  |
| ---------------- | ------------------------------------------------------ |
| **Event**        | `seat:invite:pending`                                  |
| **Created**      | 2026-02-09                                             |
| **Last Updated** | 2026-02-12                                             |
| **Sources**      | `invite-seat.handler.ts`, `invite-response.handler.ts` |

### Schema Change Log

| Date       | Change                    |
| ---------- | ------------------------- |
| 2026-02-12 | Updated source references |

---

_Documentation generated following [MSAB Broadcast Template](../../../BROADCAST_TEMPLATE.md)_
