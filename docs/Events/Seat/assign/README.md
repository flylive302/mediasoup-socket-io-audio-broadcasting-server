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

| Property                | Value                   |
| ----------------------- | ----------------------- |
| Requires Authentication | Yes (via middleware)    |
| Has Acknowledgment      | Yes (via createHandler) |
| Broadcasts              | `seat:updated` to room  |
| Requires Ownership      | Yes (room owner only)   |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `seatAssignSchema`  
**Source**: `src/socket/schemas.ts`

```typescript
export const seatAssignSchema = z.object({
  roomId: roomIdSchema,
  userId: z.number().int().positive(),
  seatIndex: z.number().int().min(0).max(99),
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
  error: "INVALID_PAYLOAD" | "Not room owner" | "Seat occupied" | "INTERNAL_ERROR"
}
```

### 2.4 Broadcast Event

**Event**: `seat:updated` (BL-007: userId only)

```typescript
{
  seatIndex: number,
  userId: number,     // Target user ID — frontend resolves from participants
  isMuted: false
}
```

---

## 3. Event Execution Flow

### 3.1 Entry Point

```typescript
export const assignSeatHandler = createHandler(
  "seat:assign",
  seatAssignSchema,
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
│ 3. SEAT-009: Lookup actual per-room seatCount from room state               │
│ 4. Call seatRepository.assignSeat(roomId, userId, seatIndex, seatCount)     │
│ 5. Broadcast seat:updated { seatIndex, userId, isMuted: false } to room    │
│ 6. Return { success: true }                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Document Metadata

| Property         | Value                                              |
| ---------------- | -------------------------------------------------- |
| **Event**        | `seat:assign`                                      |
| **Domain**       | Seat                                               |
| **Direction**    | C→S                                                |
| **Created**      | 2026-02-09                                         |
| **Last Updated** | 2026-02-12                                         |
| **Handler**      | `src/domains/seat/handlers/assign-seat.handler.ts` |

### Schema Change Log

| Date       | Change                                                   |
| ---------- | -------------------------------------------------------- |
| 2026-02-12 | Handler changed to `createHandler` pattern               |
| 2026-02-12 | `seat:updated` broadcast changed to userId-only (BL-007) |
| 2026-02-12 | Added SEAT-009 per-room seatCount lookup                 |
| 2026-02-12 | `seatIndex` max changed from 14 to 99                    |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
