# Broadcast Event: `seat:invite:received`

> **Domain**: Seat  
> **Direction**: Server → Specific User  
> **Transport**: Socket.IO  
> **Triggered By**: `seat:invite`

---

## 1. Event Overview

### Purpose

Sends a seat invitation directly to the invited user's sockets.

### Key Characteristics

| Property     | Value                                           |
| ------------ | ----------------------------------------------- |
| Target       | Only target user's sockets (not room broadcast) |
| Emitted From | `invite-seat.handler.ts`                        |
| Emitted Via  | Targeted emit to user's socket IDs              |

---

## 2. Event Payload

```typescript
{
  seatIndex: number,
  invitedById: number,     // BL-007: flat userId, not nested object
  expiresAt: number,       // Unix timestamp (30s TTL from Redis)
  targetUserId: number
}
```

> [!IMPORTANT]
> BL-007 change: Previously sent nested `invitedBy: { id, name }`. Now sends flat `invitedById` only — frontend resolves name from participants store.

---

## 3. Document Metadata

| Property         | Value                                              |
| ---------------- | -------------------------------------------------- |
| **Event**        | `seat:invite:received`                             |
| **Created**      | 2026-02-09                                         |
| **Last Updated** | 2026-02-12                                         |
| **Source**       | `src/domains/seat/handlers/invite-seat.handler.ts` |

### Schema Change Log

| Date       | Change                                                               |
| ---------- | -------------------------------------------------------------------- |
| 2026-02-12 | BL-007: Payload changed from nested `invitedBy` → flat `invitedById` |

---

_Documentation generated following [MSAB Broadcast Template](../../../BROADCAST_TEMPLATE.md)_
