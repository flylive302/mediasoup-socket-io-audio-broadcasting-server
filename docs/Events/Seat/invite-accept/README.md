# Event: `seat:invite:accept`

> **Domain**: Seat  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `seat:invite`, `seat:invite:decline`, `seat:invite:pending`, `seat:updated`, `seat:locked`

---

## 1. Event Overview

### Purpose

Allows a user to accept a pending seat invitation and automatically take the seat.

### Business Context

Completes the invite flow when a user agrees to join a seat.

### Key Characteristics

| Property                | Value                                                          |
| ----------------------- | -------------------------------------------------------------- |
| Requires Authentication | Yes (via middleware)                                           |
| Has Acknowledgment      | Yes (via createHandler)                                        |
| Broadcasts              | `seat:invite:pending` (cleared), `seat:locked`, `seat:updated` |
| Auto-Unlocks            | Yes (if seat was locked)                                       |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `seatInviteActionSchema`  
**Source**: `src/socket/schemas.ts`

```typescript
export const seatInviteActionSchema = z.object({
  roomId: roomIdSchema,
  seatIndex: z.number().int().min(0).max(99).optional(),
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
  error: "INVALID_PAYLOAD" | "NO_INVITE" | "INTERNAL_ERROR"
}
```

### 2.4 Broadcast Events

**Event 1**: `seat:invite:pending` (cleared)

```typescript
{ seatIndex: number, isPending: false }
```

**Event 2**: `seat:locked` (if seat was auto-unlocked)

```typescript
{ seatIndex: number, isLocked: false }
```

**Event 3**: `seat:updated` (BL-007: userId only)

```typescript
{
  seatIndex: number,
  userId: number,     // Accepting user — frontend resolves from participants
  isMuted: false
}
```

---

## 3. Event Execution Flow

### 3.1 Entry Point

```typescript
export const inviteAcceptHandler = createHandler(
  "seat:invite:accept",
  seatInviteActionSchema,
  async (payload, socket, context) => { ... }
);
```

### 3.2 Execution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. createHandler validates payload + room membership                        │
│ 2. Find invite by seatIndex OR by userId (if seatIndex not provided)       │
│ 3. Verify invite belongs to this user                                       │
│ 4. Delete invite from Redis                                                 │
│ 5. Broadcast seat:invite:pending (cleared)                                  │
│ 6. If seat locked → auto-unlock + broadcast seat:locked {isLocked: false}  │
│ 7. SEAT-009: Lookup per-room seatCount from state                          │
│ 8. Take seat via seatRepository.takeSeat()                                  │
│ 9. Broadcast seat:updated { seatIndex, userId, isMuted: false }            │
│ 10. Return { success: true }                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Auto-Unlock Feature

If an invited user accepts an invite to a locked seat, the seat is automatically unlocked first. Uses `seatRepository.unlockSeat()` (SEAT-002 atomic).

---

## 4. Document Metadata

| Property         | Value                                                  |
| ---------------- | ------------------------------------------------------ |
| **Event**        | `seat:invite:accept`                                   |
| **Domain**       | Seat                                                   |
| **Direction**    | C→S                                                    |
| **Created**      | 2026-02-09                                             |
| **Last Updated** | 2026-02-12                                             |
| **Handler**      | `src/domains/seat/handlers/invite-response.handler.ts` |
| **Function**     | `inviteAcceptHandler`                                  |

### Schema Change Log

| Date       | Change                                                   |
| ---------- | -------------------------------------------------------- |
| 2026-02-12 | Handler changed to `createHandler` pattern               |
| 2026-02-12 | `seat:updated` broadcast changed to userId-only (BL-007) |
| 2026-02-12 | Added SEAT-009 per-room seatCount lookup                 |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
