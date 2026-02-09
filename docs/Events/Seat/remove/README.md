# Event: `seat:remove`

> **Domain**: Seat  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `seat:cleared` (broadcast)

---

## 1. Event Overview

### Purpose

Allows the room owner to forcibly remove a user from their seat.

### Business Context

Room owners can manage disruptive users by removing them from seats.

### Key Characteristics

| Property                | Value                  |
| ----------------------- | ---------------------- |
| Requires Authentication | Yes (via middleware)   |
| Has Acknowledgment      | Yes                    |
| Broadcasts              | `seat:cleared` to room |
| Requires Ownership      | Yes (room owner only)  |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `seatRemoveSchema`  
**Source**: `src/domains/seat/seat.requests.ts:29-32`

```typescript
{
  roomId: string,     // Room ID
  userId: number      // Target user ID to remove (positive integer)
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
  error: "Invalid payload" | "Not room owner" | "User is not seated" | "Internal server error"
}
```

### 2.4 Broadcast Event

**Event**: `seat:cleared`

```typescript
{
  seatIndex: number; // Index of cleared seat
}
```

---

## 3. Event Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Validate payload with seatRemoveSchema                                   │
│ 2. Verify room ownership via verifyRoomOwner()                              │
│ 3. Call seatRepository.removeSeat(roomId, userId)                           │
│ 4. Broadcast seat:cleared to room                                           │
│ 5. Return success                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Document Metadata

| Property | Value                                              |
| -------- | -------------------------------------------------- |
| Created  | 2026-02-09                                         |
| Handler  | `src/domains/seat/handlers/remove-seat.handler.ts` |
| Schema   | `src/domains/seat/seat.requests.ts:29-32`          |
