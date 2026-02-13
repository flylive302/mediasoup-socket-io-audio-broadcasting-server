# MSAB Event Map

> **Complete map of every event flowing through MSAB**  
> Last Updated: 2026-02-13

---

## Event Flow Architecture

```
┌───────────┐   Redis Pub/Sub   ┌──────┐   Socket.IO   ┌──────────┐
│  Laravel   │ ───────────────→ │ MSAB │ ────────────→ │ Frontend │
│  Backend   │                  │      │ ←──────────── │  (Nuxt)  │
└───────────┘                   └──────┘   Socket.IO   └──────────┘
                                   │
                                   ├── Relay Events (pass-through)
                                   ├── Socket Handlers (stateful)
                                   └── Broadcast Events (server-emitted)
```

---

## All Events by Domain

### Room (15 events)

| Event                        | Direction        | Description               |
| ---------------------------- | ---------------- | ------------------------- |
| `room:join`                  | Client → Server  | Join a room               |
| `room:leave`                 | Client → Server  | Leave a room              |
| `room:userJoined`            | Server → Client  | User joined room          |
| `room:userLeft`              | Server → Client  | User left room            |
| `room:closed`                | Server → Client  | Room was closed           |
| `room.level_up`              | Laravel → Client | Room gained a level       |
| `room.participant_count`     | Laravel → Client | Participant count updated |
| `room.member_joined`         | Laravel → Client | Member joined room group  |
| `room.member_left`           | Laravel → Client | Member left room group    |
| `room.member_kicked`         | Laravel → Client | Member kicked             |
| `room.member_blocked`        | Laravel → Client | Member blocked            |
| `room.member_role_changed`   | Laravel → Client | Member role changed       |
| `room.join_request_created`  | Laravel → Client | Join request received     |
| `room.join_request_approved` | Laravel → Client | Join request approved     |
| `room.join_request_rejected` | Laravel → Client | Join request rejected     |

---

### Seat (18 events)

| Event                  | Direction       | Description                   |
| ---------------------- | --------------- | ----------------------------- |
| `seat:take`            | Client → Server | Take a seat                   |
| `seat:leave`           | Client → Server | Leave a seat                  |
| `seat:assign`          | Client → Server | Assign user to seat           |
| `seat:remove`          | Client → Server | Remove user from seat         |
| `seat:lock`            | Client → Server | Lock a seat                   |
| `seat:unlock`          | Client → Server | Unlock a seat                 |
| `seat:mute`            | Client → Server | Mute a seated user            |
| `seat:unmute`          | Client → Server | Unmute a seated user          |
| `seat:invite`          | Client → Server | Invite user to seat           |
| `seat:invite-accept`   | Client → Server | Accept seat invitation        |
| `seat:invite-decline`  | Client → Server | Decline seat invitation       |
| `seat:invite-response` | Client → Server | Seat invite response (legacy) |
| `seat:updated`         | Server → Client | Seat state changed            |
| `seat:cleared`         | Server → Client | Seat was vacated              |
| `seat:locked`          | Server → Client | Seat was locked               |
| `seat:userMuted`       | Server → Client | Seated user muted             |
| `seat:invite-pending`  | Server → Client | Seat invitation pending       |
| `seat:invite-received` | Server → Client | Seat invitation received      |

---

### Media (9 events)

| Event               | Direction       | Description                  |
| ------------------- | --------------- | ---------------------------- |
| `transport:create`  | Client → Server | Create WebRTC transport      |
| `transport:connect` | Client → Server | Connect WebRTC transport     |
| `audio:produce`     | Client → Server | Start producing audio        |
| `audio:consume`     | Client → Server | Start consuming audio        |
| `audio:selfmute`    | Client → Server | Self-mute audio              |
| `audio:selfunmute`  | Client → Server | Self-unmute audio            |
| `consumer:resume`   | Client → Server | Resume a paused consumer     |
| `audio:newProducer` | Server → Client | New audio producer available |
| `speaker:active`    | Server → Client | Active speaker changed       |

---

### Gift (4 events)

| Event           | Direction       | Description              |
| --------------- | --------------- | ------------------------ |
| `gift:prepare`  | Client → Server | Prepare gift transaction |
| `gift:send`     | Client → Server | Send a gift              |
| `gift:received` | Server → Client | Gift received in room    |
| `gift:error`    | Server → Client | Gift processing error    |

---

### Chat (1 event)

| Event          | Direction       | Description         |
| -------------- | --------------- | ------------------- |
| `chat:message` | Client → Server | Send a chat message |

---

### User (1 event)

| Event           | Direction       | Description           |
| --------------- | --------------- | --------------------- |
| `user:get-room` | Client → Server | Get room a user is in |

---

### Economy (2 relay events)

| Event             | Direction        | Description          |
| ----------------- | ---------------- | -------------------- |
| `balance.updated` | Laravel → Client | User balance changed |
| `reward.earned`   | Laravel → Client | Reward received      |

---

### Achievement (2 relay events)

| Event          | Direction        | Description     |
| -------------- | ---------------- | --------------- |
| `badge.earned` | Laravel → Client | Badge unlocked  |
| `level.up`     | Laravel → Client | User leveled up |

---

### Income Target (2 relay events)

| Event                            | Direction        | Description             |
| -------------------------------- | ---------------- | ----------------------- |
| `income_target.completed`        | Laravel → Client | Target fully achieved   |
| `income_target.member_completed` | Laravel → Client | Member hit their target |

---

### Agency (8 relay events)

| Event                          | Direction        | Description           |
| ------------------------------ | ---------------- | --------------------- |
| `agency.invitation`            | Laravel → Client | Invited to agency     |
| `agency.join_request`          | Laravel → Client | Join request created  |
| `agency.join_request_approved` | Laravel → Client | Join request approved |
| `agency.join_request_rejected` | Laravel → Client | Join request rejected |
| `agency.member_kicked`         | Laravel → Client | Member kicked         |
| `agency.member_joined`         | Laravel → Client | Member joined         |
| `agency.member_left`           | Laravel → Client | Member left           |
| `agency.dissolved`             | Laravel → Client | Agency dissolved      |

---

### System (2 relay events)

| Event               | Direction        | Description               |
| ------------------- | ---------------- | ------------------------- |
| `config:invalidate` | Laravel → Client | Config cache invalidation |
| `asset:invalidate`  | Laravel → Client | Asset cache invalidation  |

---

## Summary

| Direction        | Count  | Mechanism                            |
| ---------------- | ------ | ------------------------------------ |
| Client → Server  | **25** | Socket.IO handlers in `src/domains/` |
| Server → Client  | **13** | `socket.emit()` / `io.to().emit()`   |
| Laravel → Client | **26** | Redis pub/sub → `EventRouter` relay  |
| **Total**        | **64** |                                      |

> [!NOTE]
> **Relay events are allowlisted.** Only events registered in `RELAY_EVENTS` (`src/integrations/laravel/types.ts`) are accepted by `EventRouter`. Unregistered events are rejected. See [Relay Events README](./Events/Relay/README.md) for the registration workflow.

---

_Source: [`docs/Events/`](./Events/) · [`src/integrations/laravel/types.ts`](./src/../src/integrations/laravel/types.ts)_
