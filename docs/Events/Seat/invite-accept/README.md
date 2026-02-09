# Event: `seat:invite:accept`

> **Domain**: Seat  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `seat:invite`, `seat:invite:decline`, `seat:invite:pending`, `seat:updated`

---

## 1. Event Overview

### Purpose

Allows a user to accept a pending seat invitation and automatically take the seat.

### Business Context

Completes the invite flow when a user agrees to join a seat.

### Key Characteristics

| Property                | Value                                           |
| ----------------------- | ----------------------------------------------- |
| Requires Authentication | Yes (via middleware)                            |
| Has Acknowledgment      | Yes                                             |
| Broadcasts              | `seat:invite:pending` (cleared), `seat:updated` |
| Auto-Unlocks            | Yes (if seat was locked)                        |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `seatInviteActionSchema`  
**Source**: `src/domains/seat/seat.requests.ts:62-65`

```typescript
{
  roomId: string,
  seatIndex?: number   // Optional - if not provided, server looks up by userId
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
  error: "Invalid payload" | "No pending invite found" | "Internal server error"
}
```

### 2.4 Broadcast Events

**Event 1**: `seat:invite:pending` (cleared)

```typescript
{
  seatIndex: number,
  isPending: false
}
```

**Event 2**: `seat:locked` (if seat was auto-unlocked)

```typescript
{
  seatIndex: number,
  isLocked: false
}
```

**Event 3**: `seat:updated`

```typescript
{
  seatIndex: number,
  user: {
    id: number,
    name: string,
    avatar: string,
    signature: string,
    frame: object | null,
    gender: string,
    country: string,
    wealth_xp: number,
    charm_xp: number
  },
  isMuted: false
}
```

---

## 3. Event Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Validate payload                                                         │
│ 2. Find invite by seatIndex OR by userId                                    │
│ 3. Verify invite belongs to this user                                       │
│ 4. Delete invite from Redis                                                 │
│ 5. Broadcast seat:invite:pending (cleared)                                  │
│ 6. If seat locked, auto-unlock and broadcast                                │
│ 7. Take seat via seatRepository.takeSeat()                                  │
│ 8. Broadcast seat:updated with full user data                               │
│ 9. Return success                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Auto-Unlock Feature

If an invited user accepts an invite to a locked seat, the seat is automatically unlocked first.

---

## 4. Document Metadata

| Property | Value                                                  |
| -------- | ------------------------------------------------------ |
| Created  | 2026-02-09                                             |
| Handler  | `src/domains/seat/handlers/invite-response.handler.ts` |
| Function | `inviteAcceptHandler` (lines 13-151)                   |
| Schema   | `src/domains/seat/seat.requests.ts:62-65`              |
