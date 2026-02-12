# `room:join` Event

> **Domain**: Room  
> **Direction**: C→S  
> **Handler**: `src/domains/room/room.handler.ts:21-207`

---

## 1. Event Overview

### Event: `room:join` (C→S)

### Purpose

Allows a client to join an audio room, receive mediasoup RTP capabilities, existing participants, seats, and producers for state synchronization.

### Domain

**Room** - Room lifecycle and participant management

### Responsibilities

- Validate payload via Zod schema
- Create or retrieve mediasoup router for room
- Optionally cache room owner from frontend
- Track client in ClientManager
- Store user's room in Redis for `user:getRoom` feature
- Gather existing participants, seats, and producers (excluding self)
- Add socket to Socket.IO room
- Record activity to prevent auto-close
- Update participant count in Redis and notify Laravel
- Broadcast `room:userJoined` to other participants
- Return initial state via acknowledgment

### What It Owns

| Owned             | Description                             |
| ----------------- | --------------------------------------- |
| Room membership   | Socket joins Socket.IO room             |
| Client tracking   | ClientManager entry updated with roomId |
| User room mapping | Redis key `user:{userId}:room` set      |

### External Dependencies

| Dependency             | Type    | Purpose                       |
| ---------------------- | ------- | ----------------------------- |
| `RoomManager`          | Service | Router creation/retrieval     |
| `ClientManager`        | Service | Track client state            |
| `SeatRepository`       | Redis   | Get existing seats            |
| `UserSocketRepository` | Redis   | Track user's current room     |
| `AutoCloseService`     | Redis   | Prevent room auto-close       |
| `LaravelClient`        | HTTP    | Update room participant_count |

---

## 2. Event Contract

### Inbound Event

```
Event: room:join
Direction: C→S
Acknowledgment: ✅ Required (callback)
```

### Zod Schema

```typescript
// src/socket/schemas.ts:160-163
export const joinRoomSchema = z.object({
  roomId: z.string(),
  ownerId: z.number().optional(),
});
```

### Payload Schema

```json
{
  "roomId": "string", // Required, room identifier (numeric ID or UUID)
  "ownerId": 1234 // Optional, owner ID for permission verification
}
```

### Field Details

| Field     | Type     | Required | Constraints  | Example        |
| --------- | -------- | -------- | ------------ | -------------- |
| `roomId`  | `string` | ✅       | min 1 char   | `"42"` or UUID |
| `ownerId` | `number` | ❌       | positive int | `1234`         |

### Acknowledgment Response

```json
// Success
{
  "rtpCapabilities": {
    "codecs": [
      {
        "kind": "audio",
        "mimeType": "audio/opus",
        "clockRate": 48000,
        "channels": 2
      }
    ],
    "headerExtensions": [...]
  },
  "participants": [
    {
      "id": 123,
      "name": "John",
      "signature": "Hello!",
      "avatar": "https://...",
      "frame": "https://...",
      "gender": 0,
      "country": "US",
      "wealth_xp": 1000,
      "charm_xp": 500,
      "isSpeaker": false
    }
  ],
  "seats": [
    {
      "seatIndex": 0,
      "user": { "id": 456, "name": "Jane", "avatar": "https://..." },
      "isMuted": false
    }
  ],
  "lockedSeats": [3, 7],
  "existingProducers": [
    { "producerId": "uuid", "userId": 456 }
  ]
}

// Error
{
  "error": "Invalid payload" | "Internal error"
}
```

### Emitted Events

| Event             | Target                  | When                  |
| ----------------- | ----------------------- | --------------------- |
| `room:userJoined` | Room (excluding sender) | After successful join |

---

## 3. Event Execution Flow

### 3.1 Entry Point

```
File: src/domains/room/room.handler.ts:21
```

```typescript
socket.on("room:join", async (rawPayload: unknown, ack) => {
  // Handler logic
});
```

### 3.2 Schema Validation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SCHEMA VALIDATION                                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/room/room.handler.ts:22-27                                │
│                                                                             │
│ Validates payload with Zod joinRoomSchema.                                  │
│ Returns early with error if invalid.                                        │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const payloadResult = joinRoomSchema.safeParse(rawPayload);             │ │
│ │ if (!payloadResult.success) {                                           │ │
│ │   if (ack) ack({ error: "Invalid payload" });                           │ │
│ │   return;                                                               │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Router Initialization

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ROUTER CREATION/RETRIEVAL                                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/room/room.handler.ts:32-33                                │
│                                                                             │
│ Gets or creates mediasoup router for the room.                              │
│ If room doesn't exist, allocates least-loaded worker.                       │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const routerManager = await roomManager.getOrCreateRoom(roomId);        │ │
│ │ const rtpCapabilities = routerManager.router?.rtpCapabilities;          │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.4 Owner Caching

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ROOM OWNER CACHING (Optional)                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/room/room.handler.ts:35-40                                │
│                                                                             │
│ If ownerId provided, cache for permission checks in seat operations.        │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ if (ownerId) {                                                          │ │
│ │   setRoomOwner(roomId, String(ownerId));                                │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.5 Client State Updates

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ CLIENT TRACKING                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/room/room.handler.ts:42-48                                │
│                                                                             │
│ Updates ClientManager with roomId and Redis with user's current room.       │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const client = clientManager.getClient(socket.id);                      │ │
│ │ if (client) client.roomId = roomId;                                     │ │
│ │                                                                         │ │
│ │ await userSocketRepository.setUserRoom(userId, roomId);                 │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.6 State Gathering

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ GATHER EXISTING STATE                                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/room/room.handler.ts:50-158                               │
│                                                                             │
│ Gathers current room state BEFORE joining to exclude self:                  │
│ • participants (verified connected, excludes self)                          │
│ • seats (from Redis SeatRepository)                                         │
│ • locked seats                                                              │
│ • existing producers                                                        │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const participants = await getParticipants(roomId);                     │ │
│ │ const [roomSeatsData, lockedSeats] = await Promise.all([                │ │
│ │   seatRepository.getSeats(roomId, config.DEFAULT_SEAT_COUNT),           │ │
│ │   seatRepository.getLockedSeats(roomId),                                │ │
│ │ ]);                                                                     │ │
│ │ const existingProducers = await getProducers(roomId);                   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ **Stale Client Cleanup**: If a client socket is found in ClientManager      │
│ but not actually connected to Socket.IO, it's removed (L64-68).             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.7 Room Join

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SOCKET.IO ROOM JOIN                                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/room/room.handler.ts:160                                  │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ socket.join(roomId);                                                    │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.8 Activity Recording & Laravel Notification

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ACTIVITY & LARAVEL UPDATE                                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/room/room.handler.ts:162-175                              │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ await autoCloseService.recordActivity(roomId);                          │ │
│ │                                                                         │ │
│ │ const newCount = await roomManager.state.adjustParticipantCount(..);    │ │
│ │ if (newCount !== null) {                                                │ │
│ │   await laravelClient.updateRoomStatus(roomId, {                        │ │
│ │     is_live: true,                                                      │ │
│ │     participant_count: newCount,                                        │ │
│ │   });                                                                   │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.9 Broadcast & Response

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ BROADCAST TO OTHERS & ACK TO SENDER                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/room/room.handler.ts:177-202                              │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ // Notify others                                                        │ │
│ │ socket.to(roomId).emit("room:userJoined", {                             │ │
│ │   userId: socket.data.user.id,                                          │ │
│ │   user: socket.data.user,                                               │ │
│ │ });                                                                     │ │
│ │                                                                         │ │
│ │ // Acknowledge sender with initial state                                │ │
│ │ if (ack) ack({                                                          │ │
│ │   rtpCapabilities,                                                      │ │
│ │   participants,                                                         │ │
│ │   seats,                                                                │ │
│ │   lockedSeats,                                                          │ │
│ │   existingProducers,                                                    │ │
│ │ });                                                                     │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. State Transitions

### ClientManager (In-Memory)

| Property        | Before      | After  |
| --------------- | ----------- | ------ |
| `client.roomId` | `undefined` | `"42"` |

### Redis State

| Key Pattern                  | Operation | TTL         |
| ---------------------------- | --------- | ----------- |
| `user:{userId}:room`         | SET       | None        |
| `room:{roomId}:participants` | INCR      | None        |
| `room:{roomId}:activity`     | SET       | 30s sliding |

### Socket.IO Rooms

| Room     | Action                |
| -------- | --------------------- |
| `roomId` | `socket.join(roomId)` |

---

## 5. Reusability Matrix

| Component                           | File                            | Used By     | Reusable | Reasoning               |
| ----------------------------------- | ------------------------------- | ----------- | -------- | ----------------------- |
| `joinRoomSchema`                    | `socket/schemas.ts`             | `room:join` | ✅       | Reusable for validation |
| `getParticipants()`                 | `room.handler.ts` (inline)      | `room:join` | ❌       | Event-specific helper   |
| `getProducers()`                    | `room.handler.ts` (inline)      | `room:join` | ❌       | Event-specific helper   |
| `RoomManager.getOrCreateRoom()`     | `room/roomManager.ts`           | Multiple    | ✅       | Core room lifecycle     |
| `SeatRepository.getSeats()`         | `seat/seat.repository.ts`       | Multiple    | ✅       | Shared seat state       |
| `AutoCloseService.recordActivity()` | `room/auto-close/`              | Multiple    | ✅       | Activity tracking       |
| `LaravelClient.updateRoomStatus()`  | `integrations/laravelClient.ts` | Multiple    | ✅       | Laravel sync            |

---

## 6. Error Handling & Edge Cases

### Validation Errors

| Error             | Condition        | Response                       |
| ----------------- | ---------------- | ------------------------------ |
| `Invalid payload` | Zod schema fails | `{ error: "Invalid payload" }` |

### System Errors

| Error            | Condition                  | Response                      |
| ---------------- | -------------------------- | ----------------------------- |
| `Internal error` | Any exception in try/catch | `{ error: "Internal error" }` |

### Edge Cases

| Scenario              | Behavior                                        |
| --------------------- | ----------------------------------------------- |
| Room doesn't exist    | Created on-the-fly via `getOrCreateRoom()`      |
| Stale clients in room | Removed during `getParticipants()` verification |
| User already in room  | No special handling (duplicate join allowed)    |
| ownerId not provided  | No owner caching (may affect seat permissions)  |
| No ack callback       | Events still processed, just no response        |

---

## 7. Sequence Diagram (Textual)

```
 CLIENT          SOCKET.IO          HANDLER          ROOM_MANAGER      REDIS     LARAVEL
   │                  │                  │                  │            │          │
   │  room:join       │                  │                  │            │          │
   │  {roomId, ownerId?}                 │                  │            │          │
   │─────────────────▶│                  │                  │            │          │
   │                  │ 1. dispatch      │                  │            │          │
   │                  │─────────────────▶│                  │            │          │
   │                  │                  │ 2. validate      │            │          │
   │                  │                  │ (Zod schema)     │            │          │
   │                  │                  │                  │            │          │
   │                  │                  │ 3. getOrCreate   │            │          │
   │                  │                  │─────────────────▶│            │          │
   │                  │                  │◀─────────────────│ router     │          │
   │                  │                  │                  │            │          │
   │                  │                  │ 4. setUserRoom   │            │          │
   │                  │                  │───────────────────────────────▶          │
   │                  │                  │                  │            │          │
   │                  │                  │ 5. getSeats/lockedSeats       │          │
   │                  │                  │───────────────────────────────▶          │
   │                  │                  │◀───────────────────────────────          │
   │                  │                  │                  │            │          │
   │                  │                  │ 6. socket.join   │            │          │
   │                  │                  │                  │            │          │
   │                  │                  │ 7. recordActivity│            │          │
   │                  │                  │───────────────────────────────▶          │
   │                  │                  │                  │            │          │
   │                  │                  │ 8. adjustParticipantCount     │          │
   │                  │                  │───────────────────────────────▶          │
   │                  │                  │                  │            │          │
   │                  │                  │ 9. updateRoomStatus           │          │
   │                  │                  │──────────────────────────────────────────▶
   │                  │                  │◀──────────────────────────────────────────
   │                  │                  │                  │            │          │
   │                  │ 10. room:userJoined (to room)       │            │          │
   │                  │ 11. ack(state)   │                  │            │          │
   │◀─────────────────│                  │                  │            │          │
```

---

## 8. Cross-Platform Integration

### Frontend Usage (Nuxt)

```typescript
// composables/useRoom.ts
const joinRoom = async (roomId: string, ownerId?: number) => {
  const response = await socket.emitWithAck("room:join", { roomId, ownerId });

  if (response.error) {
    throw new Error(response.error);
  }

  // Store room state
  rtpCapabilities.value = response.rtpCapabilities;
  participants.value = response.participants;
  seats.value = response.seats;
  lockedSeats.value = response.lockedSeats;
  existingProducers.value = response.existingProducers;

  return response;
};
```

### Laravel Integration

| Endpoint                           | When Called     | Purpose                                  |
| ---------------------------------- | --------------- | ---------------------------------------- |
| `POST /internal/rooms/{id}/status` | After room join | Update `is_live` and `participant_count` |

### Related Events

| Event              | Relationship                  |
| ------------------ | ----------------------------- |
| `room:leave`       | Inverse operation             |
| `room:userJoined`  | Broadcast after this          |
| `room:userLeft`    | Broadcast when others leave   |
| `transport:create` | Typically follows join        |
| `seat:take`        | User takes seat after joining |

---

## 9. Extension & Maintenance Notes

### ✅ Where to Add New Features

| Feature Type           | Location                                   |
| ---------------------- | ------------------------------------------ |
| New join payload field | `src/socket/schemas.ts` → `joinRoomSchema` |
| New join validation    | Handler before `getOrCreateRoom()`         |
| New state in response  | Add to `ack()` call (L196-202)             |
| New broadcast data     | Add to `room:userJoined` emit (L178-181)   |

### 📝 Modification Guide

```typescript
// To add a new field to join payload:
// 1. Update src/socket/schemas.ts:
export const joinRoomSchema = z.object({
  roomId: z.string(),
  ownerId: z.number().optional(),
  newField: z.string().optional(), // Add here
});

// 2. Use in handler:
const { roomId, ownerId, newField } = payloadResult.data;

// 3. Process and include in ack if needed
```

### ⚠️ What Should NOT Be Modified Casually

| Item                     | Reason                                |
| ------------------------ | ------------------------------------- |
| `rtpCapabilities` format | mediasoup client expects exact format |
| `participants` structure | Frontend relies on exact field names  |
| `seats` structure        | Must match `seat:updated` format      |
| Schema field names       | Breaking change for clients           |

### 🚨 Common Pitfalls

| Pitfall           | Solution                                             |
| ----------------- | ---------------------------------------------------- |
| Stale client data | Handler already cleans up (L64-68)                   |
| Missing ownerId   | Seat permissions may fail; ensure frontend sends     |
| Large room state  | Consider pagination for rooms with many participants |

### 📁 File Locations Quick Reference

| Purpose        | File                                      |
| -------------- | ----------------------------------------- |
| Handler        | `src/domains/room/room.handler.ts:21-207` |
| Schema         | `src/socket/schemas.ts:160-163`           |
| RoomManager    | `src/domains/room/roomManager.ts`         |
| SeatRepository | `src/domains/seat/seat.repository.ts`     |
| Types          | `src/domains/room/types.ts`               |

---

## 10. Document Metadata

| Property               | Value                |
| ---------------------- | -------------------- |
| **Event**              | `room:join`          |
| **Domain**             | Room                 |
| **Direction**          | C→S                  |
| **Author**             | System Documentation |
| **Created**            | 2026-02-09           |
| **Last Updated**       | 2026-02-09           |
| **Node.js Version**    | ≥22.0.0              |
| **TypeScript Version** | ^5.7.0               |

---

_Documentation generated following [MSAB Documentation Standard](../../DOCUMENTATION_STANDARD.md)_
