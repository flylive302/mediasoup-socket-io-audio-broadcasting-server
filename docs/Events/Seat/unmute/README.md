# Event: `seat:unmute`

> **Domain**: Seat  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `seat:mute`, `seat:userMuted` (broadcast)

---

## 1. Event Overview

### Purpose

Allows room owners/admins to unmute a previously muted user's audio.

### Business Context

Restores speaking ability after moderation action.

### Key Characteristics

| Property                | Value                                |
| ----------------------- | ------------------------------------ |
| Requires Authentication | Yes (via middleware)                 |
| Has Acknowledgment      | Yes (via createHandler)              |
| Broadcasts              | `seat:userMuted` to room             |
| Requires Ownership      | Yes (owner or admin)                 |
| Server-Side Enforcement | Yes (resumes producer)               |
| Implementation          | SEAT-010: Shared mute/unmute factory |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `seatMuteSchema` (same as mute)  
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
  error: "INVALID_PAYLOAD" | "Not room manager" | "USER_NOT_SEATED" | "UNMUTE_FAILED" | "INTERNAL_ERROR"
}
```

### 2.4 Broadcast Event

**Event**: `seat:userMuted` (to entire room via `socket.nsp.to()`)

```typescript
{
  userId: number,
  isMuted: false
}
```

---

## 3. Event Execution Flow

### 3.1 Entry Point (SEAT-010 Factory)

```typescript
export const unmuteSeatHandler = createMuteHandler({
  event: "seat:unmute",
  muted: false,
  failError: Errors.UNMUTE_FAILED,
  producerAction: "resume",
  logAction: "unmuted",
  producerLogAction: "resumed (server-side unmute)",
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
│ 4. Update mute status via seatRepository.setMute(roomId, seatIndex, false)  │
│ 5. SERVER-SIDE: Resume user's audio producer — restores mediasoup stream   │
│ 6. Broadcast seat:userMuted { userId, isMuted: false } to entire room      │
│ 7. Return { success: true }                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Document Metadata

| Property         | Value                                              |
| ---------------- | -------------------------------------------------- |
| **Event**        | `seat:unmute`                                      |
| **Domain**       | Seat                                               |
| **Direction**    | C→S                                                |
| **Created**      | 2026-02-09                                         |
| **Last Updated** | 2026-02-12                                         |
| **Handler**      | `src/domains/seat/handlers/unmute-seat.handler.ts` |
| **Factory**      | `src/domains/seat/handlers/mute-unmute.factory.ts` |

### Schema Change Log

| Date       | Change                                                           |
| ---------- | ---------------------------------------------------------------- |
| 2026-02-12 | Handler refactored to use `createMuteHandler` factory (SEAT-010) |
| 2026-02-12 | Schema source moved to `src/socket/schemas.ts`                   |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
