# Event: `user:getRoom`

> **Domain**: User  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: None

---

## 1. Event Overview

### Purpose

Returns the room ID that a specific user is currently in.

### Business Context

Used for the "Track" feature on user profile pages, allowing users to find and join a friend's room.

### Key Characteristics

| Property                | Value                |
| ----------------------- | -------------------- |
| Requires Authentication | Yes (via middleware) |
| Has Acknowledgment      | Yes                  |
| Broadcasts              | No                   |
| Rate Limited            | No                   |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `getUserRoomSchema`  
**Source**: `src/domains/user/user.handler.ts:12-14`

```typescript
{
  userId: number; // User ID to look up
}
```

### 2.2 Acknowledgment (Success)

```typescript
{
  roomId: string | null; // Room ID if user is in a room, null otherwise
}
```

### 2.3 Acknowledgment (Error)

```typescript
{
  roomId: null,
  error: "Invalid payload" | "Internal error"
}
```

---

## 3. Event Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Validate payload with getUserRoomSchema                                  │
│ 2. Query Redis via userSocketRepository.getUserRoom(userId)                 │
│ 3. Return roomId (or null if not in a room)                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Document Metadata

| Property | Value                              |
| -------- | ---------------------------------- |
| Created  | 2026-02-09                         |
| Handler  | `src/domains/user/user.handler.ts` |
| Lines    | 23-41                              |
