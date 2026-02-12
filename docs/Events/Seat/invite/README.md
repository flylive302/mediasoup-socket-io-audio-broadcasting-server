# Event: `seat:invite`

> **Domain**: Seat  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `seat:invite:accept`, `seat:invite:decline`, `seat:invite:pending`, `seat:invite:received`

---

## 1. Event Overview

### Purpose

Allows room owners/admins to invite a specific user to take a seat.

### Business Context

Enables hosts to invite guests onto stage/speaker seats with a formal invite flow.

### Key Characteristics

| Property                | Value                                 |
| ----------------------- | ------------------------------------- |
| Requires Authentication | Yes (via middleware)                  |
| Has Acknowledgment      | Yes (via createHandler)               |
| Broadcasts              | `seat:invite:pending` to room         |
| Direct Send             | `seat:invite:received` to target user |
| Requires Ownership      | Yes (owner or admin)                  |
| Invite TTL              | 30 seconds (Redis-backed)             |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `seatInviteSchema`  
**Source**: `src/socket/schemas.ts`

```typescript
export const seatInviteSchema = z.object({
  roomId: roomIdSchema,
  userId: z.number().int().positive(),
  seatIndex: z.number().int().min(0).max(99),
});
```

### 2.2 Acknowledgment (Success)

```typescript
{
  success: true;
}
```

### 2.3 Acknowledgment (Error)

```typescript
{
  success: false,
  error: "INVALID_PAYLOAD" | "CANNOT_INVITE_SELF" | "Not room manager" |
         "SEAT_TAKEN" | "SEAT_OCCUPIED" | "INVITE_PENDING" | "INVITE_CREATE_FAILED"
}
```

### 2.4 Broadcast Events

**Event 1**: `seat:invite:pending` (to room via `socket.nsp.to()`)

```typescript
{
  seatIndex: number,
  isPending: true,
  invitedUserId: number
}
```

**Event 2**: `seat:invite:received` (to target user sockets only)

```typescript
{
  seatIndex: number,
  invitedById: number,     // BL-007: userId only — frontend resolves from participants
  expiresAt: number,       // Unix timestamp (Date.now() + 30000)
  targetUserId: number
}
```

> **Note**: Uses flat `invitedById` field, NOT a nested `invitedBy: { id, name }` object.

---

## 3. Event Execution Flow

### 3.1 Entry Point

```typescript
export const inviteSeatHandler = createHandler(
  "seat:invite",
  seatInviteSchema,
  async (payload, socket, context) => { ... }
);
```

### 3.2 Execution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. createHandler validates payload + room membership                        │
│ 2. Reject self-invite → Errors.CANNOT_INVITE_SELF                          │
│ 3. Verify manager permissions via verifyRoomManager()                       │
│ 4. SEAT-011: Check target user not already seated anywhere                 │
│ 5. Check seat not occupied via seatRepository.getSeatOccupant()            │
│ 6. Check no pending invite via seatRepository.getInvite()                  │
│ 7. Create invite with 30s TTL via seatRepository.createInvite()            │
│ 8. Broadcast seat:invite:pending to room                                    │
│ 9. Send seat:invite:received to target user via userSocketRepository       │
│ 10. Return { success: true }                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Invite Expiry

Invites are stored in Redis with a 30-second TTL. No `setTimeout` needed — Redis handles expiry automatically.

### Target User Delivery

Uses `userSocketRepository.getSocketIds()` to find all active connections for the target user and emits to each socket individually via `context.io.to(socketId).emit()`.

---

## 4. Document Metadata

| Property         | Value                                              |
| ---------------- | -------------------------------------------------- |
| **Event**        | `seat:invite`                                      |
| **Domain**       | Seat                                               |
| **Direction**    | C→S                                                |
| **Created**      | 2026-02-09                                         |
| **Last Updated** | 2026-02-12                                         |
| **Handler**      | `src/domains/seat/handlers/invite-seat.handler.ts` |

### Schema Change Log

| Date       | Change                                                  |
| ---------- | ------------------------------------------------------- |
| 2026-02-12 | Handler changed to `createHandler` pattern              |
| 2026-02-12 | `seat:invite:received` uses flat `invitedById` (BL-007) |
| 2026-02-12 | SEAT-011: Added check for target user already seated    |
| 2026-02-12 | `seatIndex` max changed from 14 to 99                   |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
