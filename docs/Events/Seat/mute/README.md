# Event: `seat:mute`

> **Domain**: Seat  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `seat:unmute`, `seat:userMuted` (broadcast)

---

## 1. Event Overview

### Purpose

Allows room owners/admins to mute a seated user's audio, both in Redis state and at the producer level.

### Business Context

Enables moderation of speakers who may be disruptive or need to be silenced temporarily.

### Key Characteristics

| Property                | Value                                |
| ----------------------- | ------------------------------------ |
| Requires Authentication | Yes (via middleware)                 |
| Has Acknowledgment      | Yes (via createHandler)              |
| Broadcasts              | `seat:userMuted` to room             |
| Requires Ownership      | Yes (owner or admin)                 |
| Server-Side Enforcement | Yes (pauses producer)                |
| Implementation          | SEAT-010: Shared mute/unmute factory |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `seatMuteSchema`  
**Source**: `src/socket/schemas.ts`

```typescript
export const seatMuteSchema = z.object({
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
  error: "INVALID_PAYLOAD" | "Not room manager" | "USER_NOT_SEATED" | "MUTE_FAILED" | "INTERNAL_ERROR"
}
```

### 2.4 Broadcast Event

**Event**: `seat:userMuted` (to entire room via `socket.nsp.to()`)

```typescript
{
  userId: number,
  isMuted: true
}
```

---

## 3. Event Execution Flow

### 3.1 Entry Point (SEAT-010 Factory)

```typescript
// Uses shared createMuteHandler factory to eliminate code duplication
export const muteSeatHandler = createMuteHandler({
  event: "seat:mute",
  muted: true,
  failError: Errors.MUTE_FAILED,
  producerAction: "pause",
  logAction: "muted",
  producerLogAction: "paused (server-side mute)",
});
```

### 3.2 Execution (inherited from factory)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. createHandler validates payload + room membership                        │
│ 2. Verify manager permissions via verifyRoomManager()                       │
│ 3. Find user's seat via seatRepository.getUserSeat()                        │
│ 4. Update mute status via seatRepository.setMute(roomId, seatIndex, true)   │
│ 5. SERVER-SIDE: Pause user's audio producer — enforced at mediasoup level  │
│ 6. Broadcast seat:userMuted { userId, isMuted: true } to entire room       │
│ 7. Return { success: true }                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Server-Side Producer Pause

Unlike self-muting, owner mute enforces silence at the mediasoup producer level:

```typescript
const producer = room?.getProducer(audioProducerId);
if (producer) {
  await producer.pause();
}
```

---

## 4. Document Metadata

| Property         | Value                                              |
| ---------------- | -------------------------------------------------- |
| **Event**        | `seat:mute`                                        |
| **Domain**       | Seat                                               |
| **Direction**    | C→S                                                |
| **Created**      | 2026-02-09                                         |
| **Last Updated** | 2026-02-12                                         |
| **Handler**      | `src/domains/seat/handlers/mute-seat.handler.ts`   |
| **Factory**      | `src/domains/seat/handlers/mute-unmute.factory.ts` |

### Schema Change Log

| Date       | Change                                                           |
| ---------- | ---------------------------------------------------------------- |
| 2026-02-12 | Handler refactored to use `createMuteHandler` factory (SEAT-010) |
| 2026-02-12 | Schema source moved to `src/socket/schemas.ts`                   |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
