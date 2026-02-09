# Event: `seat:unlock`

> **Domain**: Seat  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `seat:lock`, `seat:unlocked` (broadcast)

---

## 1. Event Overview

### Purpose

Allows room owners/admins to unlock a previously locked seat, making it available for users.

### Business Context

Opens up reserved seats for general use.

### Key Characteristics

| Property                | Value                   |
| ----------------------- | ----------------------- |
| Requires Authentication | Yes (via middleware)    |
| Has Acknowledgment      | Yes                     |
| Broadcasts              | `seat:unlocked` to room |
| Requires Ownership      | Yes (owner or admin)    |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `seatLockSchema` (same as lock)  
**Source**: `src/domains/seat/seat.requests.ts:41-44`

```typescript
{
  roomId: string,     // Room ID
  seatIndex: number   // Seat to unlock (0-14)
}
```

### 2.2 Acknowledgment (Success)

```typescript
{
  success: true;
}
```

### 2.3 Broadcast Event

**Event**: `seat:unlocked`

```typescript
{
  seatIndex: number,
  isLocked: false
}
```

---

## 3. Event Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Validate payload with seatLockSchema                                     │
│ 2. Verify manager permissions via verifyRoomManager()                       │
│ 3. Check if not locked (return error if already unlocked)                   │
│ 4. Unlock seat via seatRepository.unlockSeat()                              │
│ 5. Broadcast seat:unlocked to entire room                                   │
│ 6. Return success                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Document Metadata

| Property | Value                                              |
| -------- | -------------------------------------------------- |
| Created  | 2026-02-09                                         |
| Handler  | `src/domains/seat/handlers/unlock-seat.handler.ts` |
| Schema   | `src/domains/seat/seat.requests.ts:41-44`          |
