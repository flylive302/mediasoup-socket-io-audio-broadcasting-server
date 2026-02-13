# Broadcast Event: `room:userJoined`

> **Domain**: Room  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `room:join` handler

---

## 1. Event Overview

### Purpose

Notifies all room members when a new user joins the room.

### Key Characteristics

| Property     | Value                               |
| ------------ | ----------------------------------- |
| Target       | All sockets in room (except sender) |
| Emitted From | `room.handler.ts` (room:join flow)  |
| Emitted Via  | `socket.to(roomId).emit()`          |

---

## 2. Event Payload

```typescript
{
  userId: number,
  user: {                   // Full user object for participant store
    id: number,
    name: string,
    avatar: string,
    signature: string,
    frame: object | null,
    gender: number,
    country: string,
    wealth_xp: number,
    charm_xp: number
  }
}
```

> [!NOTE]
> BL-007: Includes full `user` nested object so existing members can add to their local participants store without a separate lookup.

---

## 3. Document Metadata

| Property         | Value                              |
| ---------------- | ---------------------------------- |
| **Event**        | `room:userJoined`                  |
| **Created**      | 2026-02-09                         |
| **Last Updated** | 2026-02-12                         |
| **Source**       | `src/domains/room/room.handler.ts` |

### Schema Change Log

| Date       | Change                                                        |
| ---------- | ------------------------------------------------------------- |
| 2026-02-12 | Fixed payload: flat fields → nested `{ userId, user }` object |

---

_Documentation generated following [MSAB Broadcast Template](../../../BROADCAST_TEMPLATE.md)_
