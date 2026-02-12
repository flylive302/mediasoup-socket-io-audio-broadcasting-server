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

| Property                | Value                   |
| ----------------------- | ----------------------- |
| Requires Authentication | Yes (via middleware)    |
| Has Acknowledgment      | Yes (via createHandler) |
| Broadcasts              | `seat:cleared` to room  |
| Requires Ownership      | No (own seat only)      |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `seatLeaveSchema`  
**Source**: `src/socket/schemas.ts`

```typescript
export const seatLeaveSchema = z.object({
  roomId: roomIdSchema, // z.string().min(1)
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
  error: "INVALID_PAYLOAD" | "User is not seated" | "INTERNAL_ERROR"
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
// Uses createHandler wrapper
export const leaveSeatHandler = createHandler(
  "seat:leave",
  seatLeaveSchema,
  async (payload, socket, context) => { ... }
);
```

### 3.2 Execution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. createHandler validates payload + room membership                        │
│ 2. Call seatRepository.leaveSeat(roomId, userId)                            │
│ 3. If not seated → return { success: false, error: result.error }           │
│ 4. Broadcast seat:cleared { seatIndex } to room                            │
│ 5. BL-001: autoCloseService.recordActivity(roomId) — fire-and-forget       │
│ 6. Return { success: true }                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Document Metadata

| Property         | Value                                             |
| ---------------- | ------------------------------------------------- |
| **Event**        | `seat:leave`                                      |
| **Domain**       | Seat                                              |
| **Direction**    | C→S                                               |
| **Created**      | 2026-02-09                                        |
| **Last Updated** | 2026-02-12                                        |
| **Handler**      | `src/domains/seat/handlers/leave-seat.handler.ts` |

### Schema Change Log

| Date       | Change                                             |
| ---------- | -------------------------------------------------- |
| 2026-02-12 | Handler changed to `createHandler` pattern         |
| 2026-02-12 | Schema source moved to `src/socket/schemas.ts`     |
| 2026-02-12 | Added `autoCloseService.recordActivity()` (BL-001) |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
