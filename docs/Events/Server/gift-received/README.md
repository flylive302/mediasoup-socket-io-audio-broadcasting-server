# Broadcast Event: `gift:received`

> **Domain**: Gift  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `gift:send`

---

## 1. Event Overview

### Purpose

Broadcasts gift to all room members (optimistic UI — sent immediately, processed async via `GiftBuffer`).

### Key Characteristics

| Property     | Value                               |
| ------------ | ----------------------------------- |
| Target       | All sockets in room (except sender) |
| Emitted From | `giftHandler.ts` (gift:send flow)   |
| Emitted Via  | `sock.to(roomId).emit()`            |

---

## 2. Event Payload

```typescript
{
  senderId: number,
  roomId: string,
  giftId: number,
  recipientId: number,
  quantity: number
}
```

> [!IMPORTANT]
> GF-008 change: Previously included `senderName` and `senderAvatar`. These fields were removed — frontend now resolves sender details from its local participants store.

---

## 3. Document Metadata

| Property         | Value                             |
| ---------------- | --------------------------------- |
| **Event**        | `gift:received`                   |
| **Created**      | 2026-02-09                        |
| **Last Updated** | 2026-02-12                        |
| **Source**       | `src/domains/gift/giftHandler.ts` |

### Schema Change Log

| Date       | Change                                                    |
| ---------- | --------------------------------------------------------- |
| 2026-02-12 | GF-008: Removed `senderName`, `senderAvatar` from payload |

---

_Documentation generated following [MSAB Broadcast Template](../../../BROADCAST_TEMPLATE.md)_
