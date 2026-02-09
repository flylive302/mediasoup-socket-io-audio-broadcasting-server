# Laravel Integration

> **Component**: External Integration  
> **Connection**: HTTP API + Redis Pub/Sub

---

## 1. Overview

MSAB integrates with the Laravel backend via two mechanisms:

1. **HTTP API** - Outbound calls from MSAB to Laravel (gift processing, room status)
2. **Redis Pub/Sub** - Inbound events from Laravel to MSAB (balance updates, achievements)

---

## 2. HTTP API (Outbound)

### 2.1 Configuration

```
LARAVEL_API_URL=https://api.flylive.app
LARAVEL_INTERNAL_KEY=your-secret-key
```

### 2.2 Endpoints

| Method | Endpoint                                                | Purpose                   |
| ------ | ------------------------------------------------------- | ------------------------- |
| POST   | `/api/v1/internal/gifts/batch`                          | Process gift transactions |
| POST   | `/api/v1/internal/rooms/{roomId}/status`                | Update room status        |
| GET    | `/api/v1/internal/rooms/{roomId}`                       | Get room data (owner_id)  |
| GET    | `/api/v1/internal/rooms/{roomId}/members/{userId}/role` | Get member role           |

### 2.3 Authentication

All requests include:

- `Authorization: Bearer {LARAVEL_INTERNAL_KEY}`
- `X-Internal-Key: {LARAVEL_INTERNAL_KEY}`

### 2.4 Timeout

All HTTP requests timeout after **10 seconds**.

---

## 3. Redis Pub/Sub (Inbound)

### 3.1 Channel

```
flylive:msab:events
```

### 3.2 Event Structure

```typescript
interface LaravelEvent {
  event: string; // Event type (e.g., "balance.updated")
  user_id: number | null; // Target user (null for room/broadcast)
  room_id: number | null; // Target room (null for user/broadcast)
  payload: object; // Event-specific data
  timestamp: string; // ISO 8601
  correlation_id: string; // UUID v4 for tracing
}
```

### 3.3 Routing Logic

| user_id | room_id | Target                         |
| ------- | ------- | ------------------------------ |
| set     | null    | Emit to user's sockets         |
| null    | set     | Emit to room                   |
| set     | set     | Emit to user's sockets in room |
| null    | null    | Broadcast to all               |

---

## 4. Known Event Types

### Economy Events

| Event             | Description          |
| ----------------- | -------------------- |
| `balance.updated` | User balance changed |
| `reward.earned`   | Reward received      |

### Achievement Events

| Event          | Description     |
| -------------- | --------------- |
| `badge.earned` | Badge unlocked  |
| `level.up`     | User leveled up |

### Room Events

| Event                        | Description               |
| ---------------------------- | ------------------------- |
| `room.level_up`              | Room gained a level       |
| `room.participant_count`     | Participant count changed |
| `room.member_joined`         | Member joined room group  |
| `room.member_left`           | Member left room group    |
| `room.member_kicked`         | Member was kicked         |
| `room.member_blocked`        | Member was blocked        |
| `room.member_role_changed`   | Member role updated       |
| `room.join_request_created`  | New join request          |
| `room.join_request_approved` | Join request approved     |
| `room.join_request_rejected` | Join request rejected     |

### Income Target Events

| Event                            | Description                  |
| -------------------------------- | ---------------------------- |
| `income_target.completed`        | Target achieved              |
| `income_target.member_completed` | Member contribution complete |

### Agency Events

| Event                          | Description          |
| ------------------------------ | -------------------- |
| `agency.invitation`            | Invited to agency    |
| `agency.join_request`          | Join request created |
| `agency.join_request_approved` | Approved             |
| `agency.join_request_rejected` | Rejected             |
| `agency.member_kicked`         | Member kicked        |
| `agency.member_joined`         | Member joined        |
| `agency.member_left`           | Member left          |
| `agency.dissolved`             | Agency dissolved     |

### System Events

| Event               | Description               |
| ------------------- | ------------------------- |
| `config:invalidate` | Config cache invalidation |
| `asset:invalidate`  | Asset cache invalidation  |

---

## 5. Document Metadata

| Property | Value                                                            |
| -------- | ---------------------------------------------------------------- |
| Created  | 2026-02-09                                                       |
| Source   | `src/integrations/laravelClient.ts`, `src/integrations/laravel/` |
