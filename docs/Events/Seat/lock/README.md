# Event: `seat:lock`

> **Domain**: Seat  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `seat:unlock`, `seat:locked`, `seat:cleared` (broadcasts)

---

## 1. Event Overview

### Purpose

Allows room owners/admins to lock a seat, preventing anyone from taking it. If occupied, the user is kicked.

### Business Context

Reserved for VIP seats or seats that should remain empty.

### Key Characteristics

| Property                | Value                                                |
| ----------------------- | ---------------------------------------------------- |
| Requires Authentication | Yes (via middleware)                                 |
| Has Acknowledgment      | Yes (via createHandler)                              |
| Broadcasts              | `seat:locked` to room (+ `seat:cleared` if occupied) |
| Requires Ownership      | Yes (owner or admin via `verifyRoomManager`)         |
| Kicks Occupant          | Yes, if seat was occupied                            |
| Producer Close          | Yes, server-side close kicked user's audio producer  |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `seatLockSchema`  
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
  error: "INVALID_PAYLOAD" | "Not room manager" | "Already locked" | "INTERNAL_ERROR"
}
```

### 2.4 Broadcast Events

**Event 1**: `seat:cleared` (if user was kicked, via `socket.nsp.to()`)

```typescript
{
  seatIndex: number;
}
```

**Event 2**: `seat:locked` (always, via `socket.nsp.to()`)

```typescript
{ seatIndex: number, isLocked: true }
```

---

## 3. Event Execution Flow

### 3.1 Entry Point

```typescript
export const lockSeatHandler = createHandler(
  "seat:lock",
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
│ 3. SEAT-001: Atomic lock via seatRepository.lockSeat() (no pre-check)      │
│ 4. If kicked user → broadcast seat:cleared + close audio producer          │
│ 5. Broadcast seat:locked { seatIndex, isLocked: true } to room            │
│ 6. Return { success: true }                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Server-Side Producer Close (on kick)

When a user is kicked from a locked seat, their audio producer is closed server-side:

```typescript
const producer = room?.getProducer(audioProducerId);
if (producer && !producer.closed) {
  producer.close();
}
kickedClient.producers.delete("audio");
kickedClient.isSpeaker = kickedClient.producers.size > 0;
```

---

## 4. Document Metadata

| Property         | Value                                            |
| ---------------- | ------------------------------------------------ |
| **Event**        | `seat:lock`                                      |
| **Domain**       | Seat                                             |
| **Direction**    | C→S                                              |
| **Created**      | 2026-02-09                                       |
| **Last Updated** | 2026-02-12                                       |
| **Handler**      | `src/domains/seat/handlers/lock-seat.handler.ts` |

### Schema Change Log

| Date       | Change                                                        |
| ---------- | ------------------------------------------------------------- |
| 2026-02-12 | Handler changed to `createHandler` pattern                    |
| 2026-02-12 | SEAT-001: Removed `isSeatLocked` pre-check — now fully atomic |
| 2026-02-12 | Added server-side producer close on kick                      |
| 2026-02-12 | `seatIndex` max changed from 14 to 99                         |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
