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

| Property                | Value                    |
| ----------------------- | ------------------------ |
| Requires Authentication | Yes (via middleware)     |
| Has Acknowledgment      | Yes                      |
| Broadcasts              | `seat:userMuted` to room |
| Requires Ownership      | Yes (owner or admin)     |
| Server-Side Enforcement | Yes (pauses producer)    |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `seatMuteSchema`  
**Source**: `src/domains/seat/seat.requests.ts:35-38`

```typescript
{
  roomId: string,     // Room ID
  userId: number      // Target user ID to mute
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
  isMuted: true
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
│ 4. Update mute status via seatRepository.setMute(roomId, seatIndex, true)   │
│ 5. Pause user's audio producer (server-side enforcement)                    │
│ 6. Broadcast seat:userMuted to entire room                                  │
│ 7. Return success                                                           │
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

| Property | Value                                            |
| -------- | ------------------------------------------------ |
| Created  | 2026-02-09                                       |
| Handler  | `src/domains/seat/handlers/mute-seat.handler.ts` |
| Schema   | `src/domains/seat/seat.requests.ts:35-38`        |
