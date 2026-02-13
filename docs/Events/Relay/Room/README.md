# Relay Events: Room

> **Domain**: Room  
> **Direction**: Laravel → MSAB → Frontend  
> **Transport**: Redis Pub/Sub → Socket.IO  
> **Source**: `RELAY_EVENTS.room` in `src/integrations/laravel/types.ts`

---

## Events

| Event                        | Routing Target | Description                         |
| ---------------------------- | -------------- | ----------------------------------- |
| `room.level_up`              | Room           | Room gained a level                 |
| `room.participant_count`     | Room           | Participant count updated           |
| `room.member_joined`         | User           | New member joined the room group    |
| `room.member_left`           | User           | Member left the room group          |
| `room.member_kicked`         | User           | Member was kicked from room group   |
| `room.member_blocked`        | User           | Member was blocked from room group  |
| `room.member_role_changed`   | User           | Member's role updated in room group |
| `room.join_request_created`  | User           | New room join request received      |
| `room.join_request_approved` | User           | Room join request approved          |
| `room.join_request_rejected` | User           | Room join request rejected          |

> [!IMPORTANT]
> These are **Laravel relay events** about room **membership/groups** (persistent data). They are different from the MSAB socket events like `room:join`, `room:userJoined`, `room:leave` which handle real-time room **presence** (who is currently connected).

---

## Payload Schemas

> [!NOTE]
> MSAB does not validate relay payloads. Schemas below are **expected contracts** between Laravel and Frontend. Verify with Laravel source.

### `room.level_up`

```typescript
/** Verify with Laravel: App\Events\Room\RoomLevelUp */
interface RoomLevelUpPayload {
  room_id: number;
  previous_level: number;
  new_level: number;
  xp_total: number;
}
```

### `room.participant_count`

```typescript
/** Verify with Laravel */
interface RoomParticipantCountPayload {
  room_id: number;
  count: number;
}
```

### `room.member_joined`

```typescript
/** Verify with Laravel: App\Events\Room\MemberJoined */
interface RoomMemberJoinedPayload {
  room_id: number;
  user: {
    id: number;
    name: string;
    avatar: string;
  };
  role: string; // e.g., "member", "moderator", "admin"
}
```

### `room.member_left`

```typescript
/** Verify with Laravel */
interface RoomMemberLeftPayload {
  room_id: number;
  user_id: number;
}
```

### `room.member_kicked`

```typescript
/** Verify with Laravel */
interface RoomMemberKickedPayload {
  room_id: number;
  user_id: number;
  kicked_by: number;
  reason?: string;
}
```

### `room.member_blocked`

```typescript
/** Verify with Laravel */
interface RoomMemberBlockedPayload {
  room_id: number;
  user_id: number;
  blocked_by: number;
  duration?: number; // Block duration in seconds (null = permanent)
}
```

### `room.member_role_changed`

```typescript
/** Verify with Laravel */
interface RoomMemberRoleChangedPayload {
  room_id: number;
  user_id: number;
  previous_role: string;
  new_role: string;
  changed_by: number;
}
```

### `room.join_request_created`

```typescript
/** Verify with Laravel */
interface RoomJoinRequestCreatedPayload {
  request_id: number;
  room_id: number;
  user: {
    id: number;
    name: string;
    avatar: string;
  };
}
```

### `room.join_request_approved`

```typescript
/** Verify with Laravel */
interface RoomJoinRequestApprovedPayload {
  room_id: number;
  room_name: string;
}
```

### `room.join_request_rejected`

```typescript
/** Verify with Laravel */
interface RoomJoinRequestRejectedPayload {
  room_id: number;
  room_name: string;
  reason?: string;
}
```

---

## Frontend Integration

```typescript
// composables/useRoomMembership.ts
socket.on("room.level_up", (payload: RoomLevelUpPayload) => {
  // Show level up animation in room UI
});

socket.on("room.member_joined", (payload: RoomMemberJoinedPayload) => {
  // Update room members list
});

socket.on(
  "room.join_request_created",
  (payload: RoomJoinRequestCreatedPayload) => {
    // Show pending request to room owner
  },
);
```

---

## Document Metadata

| Property         | Value                               |
| ---------------- | ----------------------------------- |
| **Created**      | 2026-02-13                          |
| **Last Updated** | 2026-02-13                          |
| **Source**       | `src/integrations/laravel/types.ts` |
