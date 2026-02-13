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

- `X-Internal-Key: {LARAVEL_INTERNAL_KEY}`

### 2.4 Timeout

All HTTP requests timeout after `LARAVEL_API_TIMEOUT_MS` (default: **10 seconds**).

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

### 3.3 Event Allowlist

> [!IMPORTANT]
> Only events registered in `RELAY_EVENTS` (`src/integrations/laravel/types.ts`) are accepted. Unregistered events are **rejected** with an error log and a `delivered: "rejected"` metric. You must add new events to `RELAY_EVENTS` before publishing.

### 3.4 Routing Logic

| user_id | room_id | Target                         |
| ------- | ------- | ------------------------------ |
| set     | null    | Emit to user's sockets         |
| null    | set     | Emit to room                   |
| set     | set     | Emit to user's sockets in room |
| null    | null    | Broadcast to all               |

---

## 4. Known Event Types

Events are documented per domain in [`docs/Events/Relay/`](../Events/Relay/README.md):

| Domain                                                  | Events | Description                |
| ------------------------------------------------------- | ------ | -------------------------- |
| [Economy](../Events/Relay/Economy/README.md)            | 2      | Balance changes, rewards   |
| [Achievement](../Events/Relay/Achievement/README.md)    | 2      | Badges, level ups          |
| [Room](../Events/Relay/Room/README.md)                  | 10     | Room levels, membership    |
| [Income Target](../Events/Relay/IncomeTarget/README.md) | 2      | Income target achievements |
| [Agency](../Events/Relay/Agency/README.md)              | 8      | Invitations, membership    |
| [System](../Events/Relay/System/README.md)              | 2      | Cache invalidation         |

📖 For the complete map of all events (including socket events), see [`docs/EVENT_MAP.md`](../EVENT_MAP.md).

---

## 5. Document Metadata

| Property     | Value                                                            |
| ------------ | ---------------------------------------------------------------- |
| Created      | 2026-02-09                                                       |
| Last Updated | 2026-02-13                                                       |
| Source       | `src/integrations/laravelClient.ts`, `src/integrations/laravel/` |
