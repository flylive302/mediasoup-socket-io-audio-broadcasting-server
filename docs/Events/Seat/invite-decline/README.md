# Event: `seat:invite:decline`

> **Domain**: Seat  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `seat:invite`, `seat:invite:accept`, `seat:invite:pending`

---

## 1. Event Overview

### Purpose

Allows a user to decline a pending seat invitation.

### Business Context

Provides a way for invited users to refuse an invitation politely.

### Key Characteristics

| Property                | Value                           |
| ----------------------- | ------------------------------- |
| Requires Authentication | Yes (via middleware)            |
| Has Acknowledgment      | Yes                             |
| Broadcasts              | `seat:invite:pending` (cleared) |
| Modifies State          | Deletes invite from Redis       |

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

### 2.4 Broadcast Event

**Event**: `seat:invite:pending` (cleared)

```typescript
{
  seatIndex: number,
  isPending: false
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
│ 5. Broadcast seat:invite:pending (cleared) to room                          │
│ 6. Return success                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Document Metadata

| Property | Value                                                  |
| -------- | ------------------------------------------------------ |
| Created  | 2026-02-09                                             |
| Handler  | `src/domains/seat/handlers/invite-response.handler.ts` |
| Function | `inviteDeclineHandler` (lines 153-240)                 |
| Schema   | `src/domains/seat/seat.requests.ts:62-65`              |
