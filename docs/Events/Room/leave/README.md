# `room:leave` Event

> **Domain**: Room  
> **Direction**: C→S  
> **Handler**: `src/domains/room/room.handler.ts:210-244`

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
| User room tracking      | Clears Redis `user:{id}:room` key |

### External Dependencies

| Dependency             | Type  | Purpose                    |
| ---------------------- | ----- | -------------------------- |
| `SeatRepository`       | Redis | Clear user's seat          |
| `UserSocketRepository` | Redis | Clear user's room tracking |
| `RoomManager.state`    | Redis | Adjust participant count   |
| `LaravelClient`        | HTTP  | Update room status         |

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
// src/socket/schemas.ts:165-167
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
File: src/domains/room/room.handler.ts:210
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
│ File: src/domains/room/room.handler.ts:211-215                              │
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
│ File: src/domains/room/room.handler.ts:218-226                              │
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

### 3.4 Socket.IO Room Leave

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ LEAVE SOCKET.IO ROOM                                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/room/room.handler.ts:228                                  │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ socket.leave(roomId);                                                   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.5 Redis Cleanup

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ CLEAR USER ROOM TRACKING                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/room/room.handler.ts:230-231                              │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ await userSocketRepository.clearUserRoom(socket.data.user.id);          │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.6 Laravel Notification

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ UPDATE PARTICIPANT COUNT                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/room/room.handler.ts:233-240                              │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const newCount = await roomManager.state.adjustParticipantCount(        │ │
│ │   roomId, -1                                                            │ │
│ │ );                                                                      │ │
│ │ if (newCount !== null) {                                                │ │
│ │   await laravelClient.updateRoomStatus(roomId, {                        │ │
│ │     is_live: newCount > 0,                                              │ │
│ │     participant_count: newCount,                                        │ │
│ │   });                                                                   │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ Note: is_live is set to false when participant count reaches 0.             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.7 Broadcast

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ NOTIFY REMAINING PARTICIPANTS                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/room/room.handler.ts:242-243                              │
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
   │                  │                  │                │            │          │
   │                  │                  │ 5. clearUserRoom            │          │
   │                  │                  │──────────────────────────────▶          │
   │                  │                  │                │            │          │
   │                  │                  │ 6. adjustParticipantCount   │          │
   │                  │                  │──────────────────────────────▶          │
   │                  │                  │                │            │          │
   │                  │                  │ 7. updateRoomStatus         │          │
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
// Add before socket.leave(roomId) at line 228

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
| Handler        | `src/domains/room/room.handler.ts:210-244` |
| Schema         | `src/socket/schemas.ts:165-167`            |
| SeatRepository | `src/domains/seat/seat.repository.ts`      |

---

## 10. Document Metadata

| Property               | Value                |
| ---------------------- | -------------------- |
| **Event**              | `room:leave`         |
| **Domain**             | Room                 |
| **Direction**          | C→S                  |
| **Author**             | System Documentation |
| **Created**            | 2026-02-09           |
| **Last Updated**       | 2026-02-09           |
| **Node.js Version**    | ≥22.0.0              |
| **TypeScript Version** | ^5.7.0               |

---

_Documentation generated following [MSAB Documentation Standard](../../DOCUMENTATION_STANDARD.md)_
