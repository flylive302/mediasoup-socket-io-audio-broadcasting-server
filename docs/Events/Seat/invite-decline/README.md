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
| Has Acknowledgment      | Yes (via createHandler)         |
| Broadcasts              | `seat:invite:pending` (cleared) |
| Modifies State          | Deletes invite from Redis       |

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

### 2.4 Broadcast Event

**Event**: `seat:invite:pending` (cleared, via `socket.nsp.to()`)

```typescript
{ seatIndex: number, isPending: false }
```

---

## 3. Event Execution Flow

### 3.1 Entry Point

```typescript
export const inviteDeclineHandler = createHandler(
  "seat:invite:decline",
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
│ 5. Broadcast seat:invite:pending { seatIndex, isPending: false } to room   │
│ 6. Return { success: true }                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Document Metadata

| Property         | Value                                                  |
| ---------------- | ------------------------------------------------------ |
| **Event**        | `seat:invite:decline`                                  |
| **Domain**       | Seat                                                   |
| **Direction**    | C→S                                                    |
| **Created**      | 2026-02-09                                             |
| **Last Updated** | 2026-02-12                                             |
| **Handler**      | `src/domains/seat/handlers/invite-response.handler.ts` |
| **Function**     | `inviteDeclineHandler`                                 |

### Schema Change Log

| Date       | Change                                     |
| ---------- | ------------------------------------------ |
| 2026-02-12 | Handler changed to `createHandler` pattern |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
