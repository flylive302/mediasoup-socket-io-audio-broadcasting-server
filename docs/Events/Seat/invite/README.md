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
| Has Acknowledgment      | Yes                                   |
| Broadcasts              | `seat:invite:pending` to room         |
| Direct Send             | `seat:invite:received` to target user |
| Requires Ownership      | Yes (owner or admin)                  |
| Invite TTL              | 30 seconds (Redis-backed)             |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `seatInviteSchema`  
**Source**: `src/domains/seat/seat.requests.ts:47-51`

```typescript
{
  roomId: string,     // Room ID
  userId: number,     // Target user ID to invite
  seatIndex: number   // Seat to invite to (0-14)
}
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
  error: "Invalid payload" | "Cannot invite yourself" | "Not room manager" |
         "Seat is already occupied" | "Invite already pending for this seat"
}
```

### 2.4 Broadcast Events

**Event 1**: `seat:invite:pending` (to room)

```typescript
{
  seatIndex: number,
  isPending: true,
  invitedUserId: number
}
```

**Event 2**: `seat:invite:received` (to target user only)

```typescript
{
  seatIndex: number,
  invitedBy: {
    id: number,
    name: string
  },
  expiresAt: number,   // Unix timestamp
  targetUserId: number
}
```

---

## 3. Event Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Validate payload with seatInviteSchema                                   │
│ 2. Verify not inviting self                                                 │
│ 3. Verify manager permissions via verifyRoomManager()                       │
│ 4. Check seat not occupied via seatRepository.getSeat()                     │
│ 5. Check no pending invite via seatRepository.getInvite()                   │
│ 6. Create invite with 30s TTL via seatRepository.createInvite()             │
│ 7. Broadcast seat:invite:pending to room                                    │
│ 8. Send seat:invite:received to target user sockets                         │
│ 9. Return success                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Invite Expiry

Invites are stored in Redis with a 30-second TTL. No setTimeout needed - Redis handles expiry automatically.

---

## 4. Document Metadata

| Property | Value                                              |
| -------- | -------------------------------------------------- |
| Created  | 2026-02-09                                         |
| Handler  | `src/domains/seat/handlers/invite-seat.handler.ts` |
| Schema   | `src/domains/seat/seat.requests.ts:47-51`          |
| Expiry   | 30 seconds                                         |
