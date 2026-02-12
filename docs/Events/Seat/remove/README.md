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

| Property                | Value                   |
| ----------------------- | ----------------------- |
| Requires Authentication | Yes (via middleware)    |
| Has Acknowledgment      | Yes (via createHandler) |
| Broadcasts              | `seat:cleared` to room  |
| Requires Ownership      | Yes (room owner only)   |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `seatRemoveSchema`  
**Source**: `src/socket/schemas.ts`

```typescript
export const seatRemoveSchema = z.object({
  roomId: roomIdSchema,
  userId: z.number().int().positive(),
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
  error: "INVALID_PAYLOAD" | "Not room owner" | "User is not seated" | "INTERNAL_ERROR"
}
```

### 2.4 Broadcast Event

**Event**: `seat:cleared`

```typescript
{
  seatIndex: number;
} // Index of the cleared seat
```

---

## 3. Event Execution Flow

### 3.1 Entry Point

```typescript
export const removeSeatHandler = createHandler(
  "seat:remove",
  seatRemoveSchema,
  async (payload, socket, context) => { ... }
);
```

### 3.2 Execution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. createHandler validates payload + room membership                        │
│ 2. Verify room ownership via verifyRoomOwner()                              │
│ 3. Call seatRepository.removeSeat(roomId, userId)                           │
│ 4. Broadcast seat:cleared { seatIndex: result.seatIndex } to room          │
│ 5. Return { success: true }                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Document Metadata

| Property         | Value                                              |
| ---------------- | -------------------------------------------------- |
| **Event**        | `seat:remove`                                      |
| **Domain**       | Seat                                               |
| **Direction**    | C→S                                                |
| **Created**      | 2026-02-09                                         |
| **Last Updated** | 2026-02-12                                         |
| **Handler**      | `src/domains/seat/handlers/remove-seat.handler.ts` |

### Schema Change Log

| Date       | Change                                         |
| ---------- | ---------------------------------------------- |
| 2026-02-12 | Handler changed to `createHandler` pattern     |
| 2026-02-12 | Schema source moved to `src/socket/schemas.ts` |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
