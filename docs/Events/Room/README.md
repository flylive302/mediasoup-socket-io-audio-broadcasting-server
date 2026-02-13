# Room Events

> **Domain**: Room  
> **Source**: `src/domains/room/`

---

## Client → Server (Socket.IO)

| Event        | Handler           | Description        |
| ------------ | ----------------- | ------------------ |
| `room:join`  | `room.handler.ts` | User joins a room  |
| `room:leave` | `room.handler.ts` | User leaves a room |

See: [join](./join/README.md) · [leave](./leave/README.md)

---

## Server → Client (Broadcast)

| Event             | Target            | Description              |
| ----------------- | ----------------- | ------------------------ |
| `room:userJoined` | Room (excl. self) | New user joined the room |
| `room:userLeft`   | Room              | User left the room       |
| `room:closed`     | Room              | Room was closed          |

See: [room-userJoined](./room-userJoined/README.md) · [room-userLeft](./room-userLeft/README.md) · [room-closed](./room-closed/README.md)

---

## Laravel → Frontend (Relay)

| Event                        | Target | Description               |
| ---------------------------- | ------ | ------------------------- |
| `room.level_up`              | Room   | Room gained a level       |
| `room.participant_count`     | Room   | Participant count updated |
| `room.member_joined`         | User   | Member joined room group  |
| `room.member_left`           | User   | Member left room group    |
| `room.member_kicked`         | User   | Member kicked from room   |
| `room.member_blocked`        | User   | Member blocked from room  |
| `room.member_role_changed`   | User   | Member role updated       |
| `room.join_request_created`  | User   | New join request received |
| `room.join_request_approved` | User   | Join request approved     |
| `room.join_request_rejected` | User   | Join request rejected     |

See: [Relay/Room](../Relay/Room/README.md) for full payload docs
