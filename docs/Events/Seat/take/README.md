# `seat:take` Event

> **Domain**: Seat  
> **Direction**: C→S  
> **Handler**: `src/domains/seat/handlers/take-seat.handler.ts`

---

## 1. Event Overview

### Event: `seat:take` (C→S)

### Purpose

Allows a user to take an available seat in a room. Uses atomic Redis operations for horizontal scaling safety.

### Domain

**Seat** - Seat management for speakers in audio rooms

### Responsibilities

- Validate payload via Zod schema
- Atomically claim seat slot in Redis
- Broadcast `seat:updated` to room
- Return success/failure acknowledgment

### What It Owns

| Owned           | Description                        |
| --------------- | ---------------------------------- |
| Seat assignment | Redis seat data updated atomically |
| Broadcast       | `seat:updated` with user data      |

### External Dependencies

| Dependency       | Type  | Purpose                |
| ---------------- | ----- | ---------------------- |
| `SeatRepository` | Redis | Atomic seat operations |

---

## 2. Event Contract

### Inbound Event

```
Event: seat:take
Direction: C→S
Acknowledgment: ✅ Required
```

### Zod Schema

```typescript
// src/domains/seat/seat.requests.ts (mirrors socket/schemas.ts:209-212)
export const seatTakeSchema = z.object({
  roomId: roomIdSchema,
  seatIndex: z.number().int().min(0).max(99), // Dynamic max validated by seatCount
});
```

### Payload Schema

```json
{
  "roomId": "string",
  "seatIndex": 0 // 0-14
}
```

### Field Details

| Field       | Type     | Required | Constraints | Example |
| ----------- | -------- | -------- | ----------- | ------- |
| `roomId`    | `string` | ✅       | min 1 char  | `"42"`  |
| `seatIndex` | `number` | ✅       | 0-99        | `3`     |

### Acknowledgment Response

```json
// Success
{ "success": true }

// Error
{ "success": false, "error": "Seat not available" | "Already seated" }
```

### Emitted Events

| Event          | Target                  | When       |
| -------------- | ----------------------- | ---------- |
| `seat:updated` | Room (excluding sender) | On success |

---

## 3. Event Execution Flow

### 3.1 Entry Point

```typescript
// Uses createHandler wrapper — validation, room membership, and ACK handled automatically
export const takeSeatHandler = createHandler(
  "seat:take",
  seatTakeSchema,
  async (payload, socket, context) => { ... }
);
```

### 3.2 Per-Room Seat Count Lookup

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SEAT-009: DYNAMIC SEAT COUNT                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│ Reads actual per-room seatCount from room state (not hardcoded).           │
│ Falls back to config.DEFAULT_SEAT_COUNT if state unavailable.              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Atomic Seat Claim

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ATOMIC REDIS SEAT OPERATION                                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/seat/handlers/take-seat.handler.ts:27-37                  │
│                                                                             │
│ Uses SeatRepository for horizontal scaling safety.                          │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const result = await context.seatRepository.takeSeat(                   │ │
│ │   roomId, userId, seatIndex, config.DEFAULT_SEAT_COUNT                  │ │
│ │ );                                                                      │ │
│ │                                                                         │ │
│ │ if (!result.success) {                                                  │ │
│ │   if (callback) callback({ success: false, error: result.error });      │ │
│ │   return;                                                               │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.4 Broadcast

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ BROADCAST SEAT UPDATE (BL-007: userId only)                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: take-seat.handler.ts:35-39                                            │
│                                                                             │
│ socket.to(roomId).emit("seat:updated", {                                    │
│   seatIndex,                                                                │
│   userId: socket.data.user.id,                                              │
│   isMuted: false,                                                           │
│ });                                                                         │
│                                                                             │
│ NOTE: userId only — frontend resolves full user from participants list.    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.5 Record Activity

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ BL-001: RECORD AUTO-CLOSE ACTIVITY                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│ context.autoCloseService.recordActivity(roomId).catch(() => {});            │
│ Fire-and-forget — prevents auto-close during seat actions.                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. State Transitions

### Redis State

| Key Pattern                      | Before          | After                    |
| -------------------------------- | --------------- | ------------------------ |
| `room:{roomId}:seat:{seatIndex}` | `null` or empty | `{userId, muted: false}` |

---

## 5. Error Handling

| Error                   | Condition    | Response                    |
| ----------------------- | ------------ | --------------------------- |
| `Invalid payload`       | Zod fails    | `{ success: false, error }` |
| `Seat not available`    | Seat taken   | `{ success: false, error }` |
| `Already seated`        | User in seat | `{ success: false, error }` |
| `Internal server error` | Exception    | `{ success: false, error }` |

---

## 6. Related Seat Events

| Event                 | Purpose                      |
| --------------------- | ---------------------------- |
| `seat:leave`          | User leaves their seat       |
| `seat:assign`         | Owner assigns user to seat   |
| `seat:remove`         | Owner removes user from seat |
| `seat:mute`           | Owner mutes seated user      |
| `seat:unmute`         | Owner unmutes seated user    |
| `seat:lock`           | Owner locks empty seat       |
| `seat:unlock`         | Owner unlocks seat           |
| `seat:invite`         | Owner invites user to seat   |
| `seat:invite:accept`  | User accepts invite          |
| `seat:invite:decline` | User declines invite         |

---

## 7. Cross-Platform Integration

### Frontend Usage (Nuxt)

```typescript
// composables/useSeat.ts
const takeSeat = async (roomId: string, seatIndex: number) => {
  const response = await socket.emitWithAck("seat:take", { roomId, seatIndex });
  if (!response.success) throw new Error(response.error);
  return response;
};

socket.on("seat:updated", (update) => {
  seats.value[update.seatIndex] = update;
});
```

---

## 8. Document Metadata

| Property         | Value                                            |
| ---------------- | ------------------------------------------------ |
| **Event**        | `seat:take`                                      |
| **Domain**       | Seat                                             |
| **Direction**    | C→S                                              |
| **Created**      | 2026-02-09                                       |
| **Last Updated** | 2026-02-12                                       |
| **Handler**      | `src/domains/seat/handlers/take-seat.handler.ts` |

### Schema Change Log

| Date       | Change                                                   |
| ---------- | -------------------------------------------------------- |
| 2026-02-12 | `seat:updated` broadcast changed to userId-only (BL-007) |
| 2026-02-12 | Handler changed to `createHandler` pattern               |
| 2026-02-12 | Per-room seatCount lookup from state (SEAT-009)          |
| 2026-02-12 | Added `autoCloseService.recordActivity()` (BL-001)       |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
