# `room:join` Event

> **Domain**: Room  
> **Direction**: C→S  
> **Handler**: `src/domains/room/room.handler.ts:20-187`

---

## 1. Event Overview

### Event: `room:join` (C→S)

### Purpose

Allows a client to join an audio room, receive mediasoup RTP capabilities, existing participants, seats, and producers for state synchronization.

### Domain

**Room** — Room lifecycle management

### Responsibilities

- Validate payload via Zod schema
- Create or join a mediasoup router cluster for the room
- Persist custom seat count if provided (BL-003)
- Cache room owner from frontend payload
- Build participant list, existing producers, and seat state
- Prune stale (disconnected) clients during enumeration
- Join Socket.IO room
- Parallelize Redis state updates (participant count, activity, user-socket mapping)
- Fire-and-forget Laravel room status update
- Broadcast `room:userJoined` to other room members
- Acknowledge caller with full room state

### What It Owns

| Owned                  | Description                            |
| ---------------------- | -------------------------------------- |
| Room initialization    | Creates router cluster if first joiner |
| Participant tracking   | Updates ClientManager room index       |
| State synchronization  | Returns full room snapshot via ACK     |
| User-socket mapping    | Records userId→roomId in Redis         |
| Seat count persistence | Saves custom seatCount to room state   |

### External Dependencies

| Dependency             | Type      | Purpose                  |
| ---------------------- | --------- | ------------------------ |
| `RoomManager`          | Service   | Router cluster lifecycle |
| `ClientManager`        | In-Memory | Socket↔Room tracking     |
| `SeatRepository`       | Redis     | Current seat state       |
| `AutoCloseService`     | Redis     | Record room activity     |
| `UserSocketRepository` | Redis     | User→Room mapping        |
| `LaravelClient`        | HTTP      | Room status update       |

---

## 2. Event Contract

### Inbound Event

```
Event: room:join
Direction: C→S
Acknowledgment: ✅ Required
```

### Zod Schema

```typescript
// src/socket/schemas.ts:160-165
export const joinRoomSchema = z.object({
  roomId: roomIdSchema, // z.string().min(1)
  ownerId: z.number().optional(), // Owner ID from frontend
  seatCount: z.number().int().min(1).max(15).default(15), // BL-008
});
```

### TypeScript Interfaces

```typescript
/** Inbound payload */
interface RoomJoinPayload {
  roomId: string;
  ownerId?: number;
  seatCount?: number; // defaults to 15
}

/** ACK response on success */
interface RoomJoinResponse {
  rtpCapabilities: RtpCapabilities;
  participants: MsabUser[];
  seats: SeatState[];
  lockedSeats: number[];
  existingProducers: { producerId: string; userId: number }[];
}

/** ACK response on error */
interface RoomJoinError {
  error: string; // Errors.INVALID_PAYLOAD | Errors.INTERNAL_ERROR
}

/** Participant shape */
interface MsabUser {
  id: number;
  name: string;
  signature: string;
  avatar: string;
  frame: string;
  gender: number;
  country: string;
  phone: string;
  email: string;
  date_of_birth: string;
  wealth_xp: string;
  charm_xp: string;
  isSpeaker: boolean;
}

/** BL-007: Seats use userId only — frontend resolves from participants */
interface SeatState {
  seatIndex: number;
  userId: number;
  isMuted: boolean;
}
```

### Field Details

| Field       | Type     | Required | Constraints   | Default | Example |
| ----------- | -------- | -------- | ------------- | ------- | ------- |
| `roomId`    | `string` | ✅       | min 1 char    | —       | `"42"`  |
| `ownerId`   | `number` | ❌       | positive int  | —       | `1234`  |
| `seatCount` | `number` | ❌       | 1-15, integer | `15`    | `8`     |

### Emitted Events

| Event             | Target                  | When                        |
| ----------------- | ----------------------- | --------------------------- |
| `room:userJoined` | Room (excluding sender) | After successful join + ACK |

---

## 3. Event Execution Flow

### 3.1 Entry Point

```
File: src/domains/room/room.handler.ts:20
Pattern: Raw socket.on() — does NOT use createHandler
```

### 3.2 Validation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ VALIDATE PAYLOAD                                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: room.handler.ts:21-25                                                 │
│                                                                             │
│ const payloadResult = joinRoomSchema.safeParse(rawPayload);                 │
│ if (!payloadResult.success) {                                               │
│   if (ack) ack({ error: Errors.INVALID_PAYLOAD });                         │
│   return;                                                                   │
│ }                                                                           │
│ const { roomId, seatCount } = payloadResult.data;                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Router + Seat Count Persistence

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ CREATE/GET ROUTER CLUSTER + PERSIST SEAT COUNT                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: room.handler.ts:31-41                                                 │
│                                                                             │
│ 1. roomManager.getOrCreateRoom(roomId) → cluster                           │
│ 2. Extract rtpCapabilities from cluster.router                             │
│ 3. BL-003: If seatCount ≠ 15, update room state in Redis                  │
│                                                                             │
│ File: room.handler.ts:43-48                                                 │
│ 4. Cache ownerId via setRoomOwner() if provided                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.4 Build Room Snapshot

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ BUILD PARTICIPANTS, PRODUCERS, SEATS                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: room.handler.ts:51-134                                                │
│                                                                             │
│ 1. clientManager.setClientRoom(socketId, roomId)  (PERF-006)               │
│ 2. BL-002: Single getClientsInRoom() call — iterate once to build:         │
│    • participants[] (exclude self, prune stale sockets)                     │
│    • existingProducers[] (audio producers only)                            │
│ 3. seatRepository.getSeats(roomId, seatCount) → seats + lockedSeats       │
│ 4. BL-007: Seats contain userId only (not full user object)                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.5 Join + Parallelize + Broadcast

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ JOIN ROOM + REDIS OPS + BROADCAST                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: room.handler.ts:136-186                                               │
│                                                                             │
│ 1. socket.join(roomId)                                                      │
│ 2. BL-001: Promise.all([                                                    │
│      roomManager.state.adjustParticipantCount(roomId, 1),                  │
│      autoCloseService.recordActivity(roomId),                              │
│      userSocketRepository.setUserRoom(userId, roomId)                      │
│    ])                                                                       │
│ 3. Fire-and-forget: laravelClient.updateRoomStatus() with .catch()         │
│ 4. Broadcast: socket.to(roomId).emit("room:userJoined", {                  │
│      userId, user: socket.data.user                                        │
│    })                                                                       │
│ 5. ACK: ack({ rtpCapabilities, participants, seats, lockedSeats,           │
│      existingProducers })                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. State Transitions

### Redis State

| Key Pattern                     | Before     | After                |
| ------------------------------- | ---------- | -------------------- |
| `room:{roomId}:state`           | N or count | participantCount + 1 |
| `room:{roomId}:state.seatCount` | 15         | payload.seatCount    |
| `user:{userId}:room`            | null       | roomId               |
| `room:{roomId}:activity`        | any        | updated timestamp    |

### In-Memory State

| Component      | Before          | After                  |
| -------------- | --------------- | ---------------------- |
| ClientManager  | client.roomId=∅ | client.roomId=roomId   |
| RoomManager    | may not exist   | router cluster created |
| Socket.IO room | not joined      | joined                 |

---

## 5. Reusability Matrix

| Component Used         | Also Used By             |
| ---------------------- | ------------------------ |
| `roomManager`          | `room:leave`             |
| `clientManager`        | All domain events        |
| `seatRepository`       | All seat events          |
| `autoCloseService`     | `room:leave`, chat, gift |
| `userSocketRepository` | `room:leave`, gift       |

---

## 6. Error Handling

| Error                   | Condition                  | Response                                  |
| ----------------------- | -------------------------- | ----------------------------------------- |
| `Invalid payload`       | Zod validation fails       | `ack({ error: "Invalid payload" })`       |
| `Internal server error` | Any exception in try/catch | `ack({ error: "Internal server error" })` |

---

## 7. Sequence Diagram

```
 CLIENT          SOCKET.IO          HANDLER          REDIS          LARAVEL
   │                  │                  │              │              │
   │  room:join       │                  │              │              │
   │  {roomId,        │                  │              │              │
   │   seatCount,     │                  │              │              │
   │   ownerId?}      │                  │              │              │
   │─────────────────▶│                  │              │              │
   │                  │ 1. dispatch      │              │              │
   │                  │─────────────────▶│              │              │
   │                  │                  │ 2. validate  │              │
   │                  │                  │ 3. getOrCreate│             │
   │                  │                  │──────────────▶│              │
   │                  │                  │◀──────────────│ cluster     │
   │                  │                  │ 4. persist    │              │
   │                  │                  │   seatCount   │              │
   │                  │                  │──────────────▶│              │
   │                  │                  │ 5. build      │              │
   │                  │                  │   snapshot    │              │
   │                  │                  │──────────────▶│ getSeats    │
   │                  │                  │◀──────────────│              │
   │                  │                  │ 6. join room  │              │
   │                  │                  │ 7. Promise.all│              │
   │                  │                  │──────────────▶│              │
   │                  │                  │ 8. fire&forget│              │
   │                  │                  │─────────────────────────────▶│
   │                  │ room:userJoined  │              │              │
   │                  │◀─────────────────│ (to others)  │              │
   │  ACK (state)     │                  │              │              │
   │◀─────────────────│                  │              │              │
```

---

## 8. Cross-Platform Integration

### Frontend Usage (Nuxt)

```typescript
// composables/useRoom.ts
const joinRoom = async (roomId: string, ownerId?: number) => {
  const response = await socket.emitWithAck("room:join", {
    roomId,
    ownerId,
    seatCount: roomSeatCount.value, // from room config
  });

  if ("error" in response) throw new Error(response.error);

  // Hydrate stores from response
  participants.value = response.participants;
  seats.value = response.seats; // { seatIndex, userId, isMuted }
  lockedSeats.value = response.lockedSeats;
  existingProducers.value = response.existingProducers;
  rtpCapabilities.value = response.rtpCapabilities;
};

// Listen for new joiners
socket.on("room:userJoined", ({ userId, user }) => {
  participants.value.push(user);
});
```

> **Note on BL-007**: Seats in the `room:join` response contain only `userId`. Resolve full user data from the `participants` array by matching `userId`.

---

## 9. Extension / Maintenance Notes

| Tag      | Note                                                                 |
| -------- | -------------------------------------------------------------------- |
| BL-001   | Redis ops parallelized via `Promise.all`, Laravel is fire-and-forget |
| BL-002   | Single `getClientsInRoom()` call replaces multiple lookups           |
| BL-003   | `seatCount` persisted to Redis when frontend sends non-default       |
| BL-007   | Seat response uses `userId` only (not full user object)              |
| BL-008   | `seatCount` added to Zod schema with default(15)                     |
| PERF-006 | `setClientRoom()` updates room index atomically                      |

---

## 10. Document Metadata

| Property         | Value                              |
| ---------------- | ---------------------------------- |
| **Event**        | `room:join`                        |
| **Domain**       | Room                               |
| **Direction**    | C→S                                |
| **Created**      | 2026-02-09                         |
| **Last Updated** | 2026-02-12                         |
| **Handler**      | `src/domains/room/room.handler.ts` |
| **Schema**       | `src/socket/schemas.ts` (L160-165) |

### Schema Change Log

| Date       | Change                                                                   |
| ---------- | ------------------------------------------------------------------------ |
| 2026-02-11 | Added `seatCount` field (BL-008, default: 15)                            |
| 2026-02-11 | Seats response changed from `user: MsabUser` → `userId: number` (BL-007) |
| 2026-02-11 | Participants now include `phone`, `email`, `date_of_birth` fields        |
| 2026-02-11 | `wealth_xp` / `charm_xp` type changed from `number` → `string`           |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
