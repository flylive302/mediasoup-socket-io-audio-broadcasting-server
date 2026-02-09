# Event: `seat:lock`

> **Domain**: Seat  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `seat:unlock`, `seat:locked`, `seat:cleared` (broadcasts)

---

## 1. Event Overview

### Purpose

Allows room owners/admins to lock a seat, preventing anyone from taking it. If occupied, the user is kicked.

### Business Context

Reserved for VIP seats or seats that should remain empty.

### Key Characteristics

| Property                | Value                                                |
| ----------------------- | ---------------------------------------------------- |
| Requires Authentication | Yes (via middleware)                                 |
| Has Acknowledgment      | Yes                                                  |
| Broadcasts              | `seat:locked` to room (+ `seat:cleared` if occupied) |
| Requires Ownership      | Yes (owner or admin)                                 |
| Kicks Occupant          | Yes, if seat was occupied                            |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `seatLockSchema`  
**Source**: `src/domains/seat/seat.requests.ts:41-44`

```typescript
{
  roomId: string,     // Room ID
  seatIndex: number   // Seat to lock (0-14)
}
```

### 2.2 Acknowledgment (Success)

```typescript
{
  success: true;
}
```

### 2.3 Broadcast Events

**Event 1**: `seat:cleared` (if user was kicked)

```typescript
{
  seatIndex: number;
}
```

**Event 2**: `seat:locked`

```typescript
{
  seatIndex: number,
  isLocked: true
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
│ 3. Check if already locked via seatRepository.isSeatLocked()                │
│ 4. Lock seat via seatRepository.lockSeat() (kicks occupant if any)          │
│ 5. If kicked, broadcast seat:cleared                                        │
│ 6. Broadcast seat:locked to entire room                                     │
│ 7. Return success                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Document Metadata

| Property | Value                                            |
| -------- | ------------------------------------------------ |
| Created  | 2026-02-09                                       |
| Handler  | `src/domains/seat/handlers/lock-seat.handler.ts` |
| Schema   | `src/domains/seat/seat.requests.ts:41-44`        |
