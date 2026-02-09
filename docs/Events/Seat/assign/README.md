# Event: `seat:assign`

> **Domain**: Seat  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `seat:updated` (broadcast)

---

## 1. Event Overview

### Purpose

Allows the room owner to assign a user to a specific seat.

### Business Context

Room owners can manage seating by assigning participants to specific seats, used for organizing speakers or VIPs.

### Key Characteristics

| Property                | Value                  |
| ----------------------- | ---------------------- |
| Requires Authentication | Yes (via middleware)   |
| Has Acknowledgment      | Yes                    |
| Broadcasts              | `seat:updated` to room |
| Requires Ownership      | Yes (room owner only)  |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `seatAssignSchema`  
**Source**: `src/domains/seat/seat.requests.ts:22-26`

```typescript
{
  roomId: string,          // Room ID
  userId: number,          // Target user ID (positive integer)
  seatIndex: number        // Seat index (0-14)
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
  error: "Invalid payload" | "Not room owner" | "Seat occupied" | "Internal server error"
}
```

### 2.4 Broadcast Event

**Event**: `seat:updated`

```typescript
{
  seatIndex: number,
  user: { id: number },
  isMuted: false
}
```

---

## 3. Event Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Validate payload with seatAssignSchema                                   │
│ 2. Verify room ownership via verifyRoomOwner()                              │
│ 3. Call seatRepository.assignSeat(roomId, userId, seatIndex)                │
│ 4. Broadcast seat:updated to room                                           │
│ 5. Return success                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Document Metadata

| Property | Value                                              |
| -------- | -------------------------------------------------- |
| Created  | 2026-02-09                                         |
| Handler  | `src/domains/seat/handlers/assign-seat.handler.ts` |
| Schema   | `src/domains/seat/seat.requests.ts:22-26`          |
