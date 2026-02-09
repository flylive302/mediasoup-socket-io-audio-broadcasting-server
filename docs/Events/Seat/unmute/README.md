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

| Property                | Value                    |
| ----------------------- | ------------------------ |
| Requires Authentication | Yes (via middleware)     |
| Has Acknowledgment      | Yes                      |
| Broadcasts              | `seat:userMuted` to room |
| Requires Ownership      | Yes (owner or admin)     |
| Server-Side Enforcement | Yes (resumes producer)   |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `seatMuteSchema` (same as mute)  
**Source**: `src/domains/seat/seat.requests.ts:35-38`

```typescript
{
  roomId: string,     // Room ID
  userId: number      // Target user ID to unmute
}
```

### 2.2 Acknowledgment (Success)

```typescript
{
  success: true;
}
```

### 2.3 Broadcast Event

**Event**: `seat:userMuted`

```typescript
{
  userId: number,
  isMuted: false
}
```

---

## 3. Event Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Validate payload with seatMuteSchema                                     │
│ 2. Verify manager permissions via verifyRoomManager()                       │
│ 3. Find user's seat via seatRepository.getUserSeat()                        │
│ 4. Update mute status via seatRepository.setMute(roomId, seatIndex, false)  │
│ 5. Resume user's audio producer (server-side)                               │
│ 6. Broadcast seat:userMuted with isMuted: false                             │
│ 7. Return success                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Document Metadata

| Property | Value                                              |
| -------- | -------------------------------------------------- |
| Created  | 2026-02-09                                         |
| Handler  | `src/domains/seat/handlers/unmute-seat.handler.ts` |
| Schema   | `src/domains/seat/seat.requests.ts:35-38`          |
