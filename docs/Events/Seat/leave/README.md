# Event: `seat:leave`

> **Domain**: Seat  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `seat:take`, `seat:cleared` (broadcast)

---

## 1. Event Overview

### Purpose

Allows a user to voluntarily leave their current seat in a room.

### Business Context

Users can take and leave seats freely. When leaving, the seat becomes available for others.

### Key Characteristics

| Property                | Value                  |
| ----------------------- | ---------------------- |
| Requires Authentication | Yes (via middleware)   |
| Has Acknowledgment      | Yes                    |
| Broadcasts              | `seat:cleared` to room |
| Requires Ownership      | No (own seat only)     |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `seatLeaveSchema`  
**Source**: `src/domains/seat/seat.requests.ts:17-19`

```typescript
{
  roomId: string; // Room ID (min 1 char)
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
  error: "Invalid payload" | "User is not seated" | "Internal server error"
}
```

### 2.4 Broadcast Event

**Event**: `seat:cleared`

```typescript
{
  seatIndex: number; // Index of cleared seat (0-14)
}
```

---

## 3. Event Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Validate payload with seatLeaveSchema                                    │
│ 2. Call seatRepository.leaveSeat(roomId, userId)                            │
│ 3. If not seated, return error                                              │
│ 4. Broadcast seat:cleared to room                                           │
│ 5. Return success                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Document Metadata

| Property | Value                                             |
| -------- | ------------------------------------------------- |
| Created  | 2026-02-09                                        |
| Handler  | `src/domains/seat/handlers/leave-seat.handler.ts` |
| Schema   | `src/domains/seat/seat.requests.ts:17-19`         |
