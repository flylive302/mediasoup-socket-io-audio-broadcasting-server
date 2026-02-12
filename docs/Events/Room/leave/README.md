# `room:leave` Event

> **Domain**: Room  
> **Direction**: C→S  
> **Handler**: `src/domains/room/room.handler.ts:189-234`

---

## 1. Event Overview

### Event: `room:leave` (C→S)

### Purpose

Allows a client to leave an audio room, cleaning up their seat, room membership, and notifying other participants.

### Domain

**Room** - Room lifecycle and participant management

### Responsibilities

- Validate payload via Zod schema
- Clear user's seat if seated (Redis)
- Broadcast `seat:cleared` if seat was occupied
- Remove socket from Socket.IO room
- Clear user's room tracking in Redis
- Update participant count and notify Laravel
- Broadcast `room:userLeft` to remaining participants

### What It Owns

| Owned                   | Description                       |
| ----------------------- | --------------------------------- |
| Room membership removal | Socket leaves Socket.IO room      |
| Seat cleanup            | Clears Redis seat data            |
| Client room clearing    | Clears ClientManager room index   |
| User room tracking      | Clears Redis `user:{id}:room` key |

### External Dependencies

| Dependency             | Type      | Purpose                    |
| ---------------------- | --------- | -------------------------- |
| `SeatRepository`       | Redis     | Clear user's seat          |
| `ClientManager`        | In-Memory | Clear room index           |
| `UserSocketRepository` | Redis     | Clear user's room tracking |
| `RoomManager.state`    | Redis     | Adjust participant count   |
| `AutoCloseService`     | Redis     | Record room activity       |
| `LaravelClient`        | HTTP      | Update room status         |

---

## 2. Event Contract

### Inbound Event

```
Event: room:leave
Direction: C→S
Acknowledgment: ❌ Not used
```

### Zod Schema

```typescript
// src/socket/schemas.ts:167-169
export const leaveRoomSchema = z.object({
  roomId: roomIdSchema,
});
```

### Payload Schema

```json
{
  "roomId": "string" // Required, room identifier
}
```

### Field Details

| Field    | Type     | Required | Constraints | Example |
| -------- | -------- | -------- | ----------- | ------- |
| `roomId` | `string` | ✅       | min 1 char  | `"42"`  |

### Emitted Events

| Event           | Target                  | When               |
| --------------- | ----------------------- | ------------------ |
| `seat:cleared`  | Room (excluding sender) | If user was seated |
| `room:userLeft` | Room (excluding sender) | Always after leave |

---

## 3. Event Execution Flow

### 3.1 Entry Point

```
File: src/domains/room/room.handler.ts:190
Pattern: Raw socket.on() — does NOT use createHandler
```

```typescript
socket.on("room:leave", async (rawPayload: unknown) => {
  // Handler logic - no acknowledgment
});
```

### 3.2 Schema Validation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SCHEMA VALIDATION                                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/room/room.handler.ts:191-195                              │
│                                                                             │
│ Validates payload with Zod. Silently ignores invalid requests.              │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const payloadResult = leaveRoomSchema.safeParse(rawPayload);            │ │
│ │ if (!payloadResult.success) {                                           │ │
│ │   return; // Silently ignore invalid leave requests                     │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Seat Cleanup

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ CLEAR USER'S SEAT                                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/room/room.handler.ts:199-206                              │
│                                                                             │
│ Uses Redis-backed SeatRepository to remove user from any seat.              │
│ Broadcasts seat:cleared if user was seated.                                 │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const result = await seatRepository.leaveSeat(roomId, userId);          │ │
│ │ if (result.success && result.seatIndex !== undefined) {                 │ │
│ │   socket.to(roomId).emit("seat:cleared", {                              │ │
│ │     seatIndex: result.seatIndex                                         │ │
│ │   });                                                                   │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.4 Leave Room + Clear Client Index

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ LEAVE SOCKET.IO ROOM + CLEAR CLIENT ROOM INDEX                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/room/room.handler.ts:208-211                              │
│                                                                             │
│ socket.leave(roomId);                                                       │
│ clientManager.clearClientRoom(socket.id);  // ROOM-BL-002 fix              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.5 Parallelized Redis Cleanup

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ PARALLEL REDIS OPS (BL-001 FIX)                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/room/room.handler.ts:214-218                              │
│                                                                             │
│ const [newCount] = await Promise.all([                                      │
│   roomManager.state.adjustParticipantCount(roomId, -1),                     │
│   userSocketRepository.clearUserRoom(socket.data.user.id),                  │
│   autoCloseService.recordActivity(roomId),                                  │
│ ]);                                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.6 Fire-and-Forget Laravel Notification

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ FIRE-AND-FORGET LARAVEL UPDATE                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/room/room.handler.ts:220-230                              │
│                                                                             │
│ if (newCount !== null) {                                                    │
│   laravelClient.updateRoomStatus(roomId, {                                  │
│     is_live: newCount > 0,                                                  │
│     participant_count: newCount,                                            │
│   }).catch(err => logger.error(...));   // Fire-and-forget with .catch()    │
│ }                                                                           │
│                                                                             │
│ Note: is_live is set to false when participant count reaches 0.             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.7 Broadcast

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ NOTIFY REMAINING PARTICIPANTS                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/room/room.handler.ts:233                                  │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ socket.to(roomId).emit("room:userLeft", {                               │ │
│ │   userId: socket.data.user.id                                           │ │
│ │ });                                                                     │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. State Transitions

### SeatRepository (Redis)

| Key Pattern                  | Before            | After             |
| ---------------------------- | ----------------- | ----------------- |
| `room:{roomId}:seat:{index}` | `{userId, muted}` | `null` or removed |

### UserSocketRepository (Redis)

| Key Pattern          | Before   | After   |
| -------------------- | -------- | ------- |
| `user:{userId}:room` | `roomId` | Deleted |

### RoomManager State (Redis)

| Key Pattern                  | Operation |
| ---------------------------- | --------- |
| `room:{roomId}:participants` | DECR by 1 |

### Socket.IO Rooms

| Room     | Action                 |
| -------- | ---------------------- |
| `roomId` | `socket.leave(roomId)` |

---

## 5. Reusability Matrix

| Component                              | File                                | Used By      | Reusable | Reasoning |
| -------------------------------------- | ----------------------------------- | ------------ | -------- | --------- |
| `leaveRoomSchema`                      | `socket/schemas.ts`                 | `room:leave` | ✅       | Reusable  |
| `SeatRepository.leaveSeat()`           | `seat/seat.repository.ts`           | Multiple     | ✅       | Shared    |
| `UserSocketRepository.clearUserRoom()` | `laravel/user-socket.repository.ts` | Multiple     | ✅       | Shared    |
| `LaravelClient.updateRoomStatus()`     | `integrations/laravelClient.ts`     | Multiple     | ✅       | Shared    |

---

## 6. Error Handling & Edge Cases

### Validation Errors

| Error           | Condition | Response                            |
| --------------- | --------- | ----------------------------------- |
| Invalid payload | Zod fails | Silently ignored (no error emitted) |

### Edge Cases

| Scenario           | Behavior                                                      |
| ------------------ | ------------------------------------------------------------- |
| User not in room   | `socket.leave()` is safe, no error                            |
| User not seated    | `leaveSeat()` returns `{success: true, seatIndex: undefined}` |
| Room now empty     | `is_live: false` sent to Laravel                              |
| Network disconnect | `disconnect` handler in `socket/index.ts` handles cleanup     |

---

## 7. Sequence Diagram (Textual)

```
 CLIENT          SOCKET.IO          HANDLER          SEAT_REPO       REDIS      LARAVEL
   │                  │                  │                │            │          │
   │  room:leave      │                  │                │            │          │
   │  {roomId}        │                  │                │            │          │
   │─────────────────▶│                  │                │            │          │
   │                  │ 1. dispatch      │                │            │          │
   │                  │─────────────────▶│                │            │          │
   │                  │                  │ 2. validate    │            │          │
   │                  │                  │                │            │          │
   │                  │                  │ 3. leaveSeat   │            │          │
   │                  │                  │───────────────▶│            │          │
   │                  │                  │◀───────────────│ result     │          │
   │                  │                  │                │            │          │
   │                  │ [if seated] seat:cleared (to room)│            │          │
   │                  │                  │                │            │          │
   │                  │                  │ 4. socket.leave│            │          │
   │                  │                  │ 5. clearClientRoom          │          │
   │                  │                  │                │            │          │
   │                  │                  │ 6. Promise.all [            │          │
   │                  │                  │   adjustParticipantCount,   │          │
   │                  │                  │   clearUserRoom,            │          │
   │                  │                  │   recordActivity ]          │          │
   │                  │                  │──────────────────────────────▶          │
   │                  │                  │                │            │          │
   │                  │                  │ 7. fire&forget Laravel      │          │
   │                  │                  │─────────────────────────────────────────▶
   │                  │                  │                │            │          │
   │                  │ 8. room:userLeft (to room)        │            │          │
   │                  │                  │                │            │          │
```

---

## 8. Cross-Platform Integration

### Frontend Usage (Nuxt)

```typescript
// composables/useRoom.ts
const leaveRoom = (roomId: string) => {
  socket.emit("room:leave", { roomId });

  // Clear local state
  participants.value = [];
  seats.value = [];
  currentRoomId.value = null;
};
```

### Laravel Integration

| Endpoint                           | When Called | Purpose                               |
| ---------------------------------- | ----------- | ------------------------------------- |
| `POST /internal/rooms/{id}/status` | After leave | Update `participant_count`, `is_live` |

### Related Events

| Event           | Relationship                 |
| --------------- | ---------------------------- |
| `room:join`     | Inverse operation            |
| `room:userLeft` | Broadcast after this         |
| `seat:cleared`  | Broadcast if user was seated |

---

## 9. Extension & Maintenance Notes

### ✅ Where to Add New Features

| Feature Type          | Location                |
| --------------------- | ----------------------- |
| Cleanup logic         | Before `socket.leave()` |
| Additional broadcasts | After seat cleanup      |

### 📝 Modification Guide

```typescript
// To add cleanup of additional resources:
// Add before socket.leave(roomId) at line ~208

// Example: Clear user's transports
const client = clientManager.getClient(socket.id);
if (client) {
  for (const [, transport] of client.transports) {
    transport.close();
  }
  client.transports.clear();
}
```

### ⚠️ What Should NOT Be Modified Casually

| Item                    | Reason                        |
| ----------------------- | ----------------------------- |
| Seat cleanup order      | Must happen before room leave |
| `room:userLeft` payload | Frontend expects `{ userId }` |

### 🚨 Common Pitfalls

| Pitfall               | Solution                         |
| --------------------- | -------------------------------- |
| Duplicate leave calls | Safe - operations are idempotent |
| Leave wrong room      | Validate roomId matches current  |

### 📁 File Locations Quick Reference

| Purpose        | File                                       |
| -------------- | ------------------------------------------ |
| Handler        | `src/domains/room/room.handler.ts:189-234` |
| Schema         | `src/socket/schemas.ts:167-169`            |
| SeatRepository | `src/domains/seat/seat.repository.ts`      |

---

## 10. Document Metadata

| Property         | Value                              |
| ---------------- | ---------------------------------- |
| **Event**        | `room:leave`                       |
| **Domain**       | Room                               |
| **Direction**    | C→S                                |
| **Created**      | 2026-02-09                         |
| **Last Updated** | 2026-02-12                         |
| **Handler**      | `src/domains/room/room.handler.ts` |
| **Schema**       | `src/socket/schemas.ts` (L167-169) |

### Schema Change Log

| Date       | Change                                                |
| ---------- | ----------------------------------------------------- |
| 2026-02-12 | Added `clientManager.clearClientRoom()` (ROOM-BL-002) |
| 2026-02-12 | Redis ops parallelized via `Promise.all` (BL-001)     |
| 2026-02-12 | Laravel update changed to fire-and-forget             |
| 2026-02-12 | `autoCloseService.recordActivity()` added to cleanup  |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
