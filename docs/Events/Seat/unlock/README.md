# Event: `seat:unlock`

> **Domain**: Seat  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `seat:lock`, `seat:locked` (broadcast — same event, `isLocked: false`)

---

## 1. Event Overview

### Purpose

Allows room owners/admins to unlock a previously locked seat, making it available for users.

### Business Context

Opens up reserved seats for general use.

### Key Characteristics

| Property                | Value                   |
| ----------------------- | ----------------------- |
| Requires Authentication | Yes (via middleware)    |
| Has Acknowledgment      | Yes (via createHandler) |
| Broadcasts              | `seat:locked` to room   |
| Requires Ownership      | Yes (owner or admin)    |

> **Note**: The broadcast event is `seat:locked` with `isLocked: false` — not a separate `seat:unlocked` event.

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `seatLockSchema` (same as lock)  
**Source**: `src/socket/schemas.ts`

```typescript
export const seatLockSchema = z.object({
  roomId: roomIdSchema,
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
  error: "INVALID_PAYLOAD" | "Not room manager" | "Not locked" | "INTERNAL_ERROR"
}
```

### 2.4 Broadcast Event

**Event**: `seat:locked` (via `socket.nsp.to()`)

```typescript
{ seatIndex: number, isLocked: false }
```

---

## 3. Event Execution Flow

### 3.1 Entry Point

```typescript
export const unlockSeatHandler = createHandler(
  "seat:unlock",
  seatLockSchema,
  async (payload, socket, context) => { ... }
);
```

### 3.2 Execution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. createHandler validates payload + room membership                        │
│ 2. Verify manager permissions via verifyRoomManager()                       │
│ 3. SEAT-002: Atomic unlock via seatRepository.unlockSeat() (no pre-check)  │
│ 4. Broadcast seat:locked { seatIndex, isLocked: false } to room            │
│ 5. Return { success: true }                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Document Metadata

| Property         | Value                                              |
| ---------------- | -------------------------------------------------- |
| **Event**        | `seat:unlock`                                      |
| **Domain**       | Seat                                               |
| **Direction**    | C→S                                                |
| **Created**      | 2026-02-09                                         |
| **Last Updated** | 2026-02-12                                         |
| **Handler**      | `src/domains/seat/handlers/unlock-seat.handler.ts` |

### Schema Change Log

| Date       | Change                                                        |
| ---------- | ------------------------------------------------------------- |
| 2026-02-12 | Handler changed to `createHandler` pattern                    |
| 2026-02-12 | SEAT-002: Removed `isSeatLocked` pre-check — now fully atomic |
| 2026-02-12 | Broadcast event corrected: `seat:locked` not `seat:unlocked`  |
| 2026-02-12 | `seatIndex` max changed from 14 to 99                         |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
