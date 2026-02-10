# MSAB Team Implementation Guide: Bootstrap System Integration

> **Technical Document for MSAB Real-time Server Team**
>
> Date: 2026-01-15 | Laravel Status: **IMPLEMENTED** | MSAB Status: **PENDING**

---

## Executive Summary

Laravel has implemented its side of the Bootstrap System integration. This document provides everything the MSAB team needs to complete their implementation.

### What Laravel Does (COMPLETE)

- Emits events to Redis pub/sub when actions occur
- Packages events with routing metadata (user_id, room_id)
- Uses queued jobs for reliability

### What MSAB Must Do (YOUR RESPONSIBILITY)

- Subscribe to Redis channel
- Parse event messages
- Route events to appropriate WebSocket clients

---

## 1. Laravel Implementation Summary

### Files Created

| File                                                                                                  | Purpose                            |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------- |
| [MSABEventService.php](file:///home/xha/FlyLive/backend-Laravel-12/app/Services/MSABEventService.php) | Service for emitting events        |
| [EmitMSABEvent.php](file:///home/xha/FlyLive/backend-Laravel-12/app/Jobs/EmitMSABEvent.php)           | Queued job that publishes to Redis |
| [config/database.php](file:///home/xha/FlyLive/backend-Laravel-12/config/database.php)                | Added `msab` Redis connection      |
| [config/services.php](file:///home/xha/FlyLive/backend-Laravel-12/config/services.php)                | MSAB configuration                 |

### Services Updated to Emit Events

| Service                  | Events Emitted                                     |
| ------------------------ | -------------------------------------------------- |
| `GiftTransactionService` | `gift.sent`, `balance.updated` (sender + receiver) |
| `BadgeService`           | `badge.earned`                                     |

---

## 2. Redis Configuration

### Connection Details

```env
# Environment variables Laravel uses
MSAB_REDIS_HOST=127.0.0.1      # Same Redis instance (local dev)
MSAB_REDIS_PORT=6379
MSAB_REDIS_DB=3                 # Separate database from Laravel's 0-2
MSAB_EVENTS_CHANNEL=flylive:msab:events
```

### Channel Name

```
flylive:msab:events
```

**Important**: Laravel publishes to this exact channel. MSAB must subscribe to it.

### No Prefix

Laravel's MSAB Redis connection uses **no prefix** for cross-server compatibility:

```php
'msab' => [
    // ... other config
    'prefix' => '',  // No prefix
],
```

---

## 3. Event Message Format

### JSON Structure

Every message published to `flylive:msab:events` follows this format:

```typescript
interface MSABEvent {
  event: string; // Event type (e.g., "balance.updated")
  user_id: number | null; // Target user (null for broadcast)
  room_id: number | null; // Target room (for room-wide events)
  payload: object; // Event-specific data
  timestamp: string; // ISO 8601 (e.g., "2026-01-15T00:00:00Z")
  correlation_id: string; // UUID v4 for tracing
}
```

### Routing Logic

| Condition                    | Action                                       |
| ---------------------------- | -------------------------------------------- |
| `user_id` is set             | Send to that user's socket(s) only (private) |
| `room_id` is set             | Send to all sockets in that room             |
| Both `user_id` and `room_id` | Send to that user in that room context       |
| Both null                    | Broadcast to all connected clients           |

---

## 4. Events Currently Emitted by Laravel

### 4.1. `balance.updated`

**Trigger**: Gift transaction completes

**Routing**: Private to `user_id`

**Payload**:

```typescript
{
  coins: string; // Current balance (string for precision)
  diamonds: string;
  wealth_xp: string;
  charm_xp: string;
}
```

**Example Message**:

```json
{
  "event": "balance.updated",
  "user_id": 123,
  "room_id": null,
  "payload": {
    "coins": "15000.000",
    "diamonds": "500.000",
    "wealth_xp": "25000.0000",
    "charm_xp": "12000.0000"
  },
  "timestamp": "2026-01-15T00:30:00+05:00",
  "correlation_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

---

### 4.2. `badge.earned`

**Trigger**: User is awarded a badge

**Routing**: Private to `user_id`

**Payload**:

```typescript
{
  badge_id: number;
  badge_name: string;
  badge_image: string;
  category: string; // 'wealth' | 'charm' | 'room' | 'special'
  context: string; // Source type (e.g., "level_up", "gift_received")
}
```

**Example Message**:

```json
{
  "event": "badge.earned",
  "user_id": 456,
  "room_id": null,
  "payload": {
    "badge_id": 15,
    "badge_name": "Gold Spender",
    "badge_image": "https://ik.imagekit.io/flylive/badges/gold-spender.png",
    "category": "wealth",
    "context": "level_up"
  },
  "timestamp": "2026-01-15T00:31:00+05:00",
  "correlation_id": "b2c3d4e5-f6a7-8901-bcde-f23456789012"
}
```

---

### 4.3. `gift.sent`

**Trigger**: Gift transaction completes

**Routing**: Room-wide (all users in `room_id`)

**Payload**:

```typescript
{
  sender_id: number;
  receiver_id: number;
  gift_id: number;
  gift_name: string;
  gift_thumbnail: string;
  quantity: number;
  total_value: string; // Total coin value
}
```

**Example Message**:

```json
{
  "event": "gift.sent",
  "user_id": null,
  "room_id": 789,
  "payload": {
    "sender_id": 123,
    "receiver_id": 456,
    "gift_id": 42,
    "gift_name": "Golden Heart",
    "gift_thumbnail": "https://ik.imagekit.io/flylive/gifts/golden-heart.png",
    "quantity": 5,
    "total_value": "5000.000"
  },
  "timestamp": "2026-01-15T00:32:00+05:00",
  "correlation_id": "c3d4e5f6-a7b8-9012-cdef-345678901234"
}
```

---

## 5. Events MSAB Must Handle (from MSAB_REQUIREMENTS.md)

Laravel will emit these events as features are integrated. MSAB should be ready to handle all of them:

### HIGH Priority

| Event                     | user_id | room_id | Payload                                         |
| ------------------------- | ------- | ------- | ----------------------------------------------- |
| `balance.updated`         | ✓       | null    | `{coins, diamonds, wealth_xp, charm_xp}`        |
| `badge.earned`            | ✓       | null    | `{badge_id, badge_name, badge_image, category}` |
| `reward.earned`           | ✓       | null    | `{reward: {id, type, amount, description}}`     |
| `income_target.completed` | ✓       | null    | `{target: {id, tier, reward_coins}}`            |
| `room.level_up`           | null    | ✓       | `{new_level, new_room_xp}`                      |

### MEDIUM Priority (Agency Events)

| Event                          | user_id   | room_id | Payload                               |
| ------------------------------ | --------- | ------- | ------------------------------------- |
| `agency.invitation`            | ✓         | null    | `{invitation_id, agency, invited_by}` |
| `agency.join_request`          | ✓ (owner) | null    | `{request_id, user}`                  |
| `agency.join_request_approved` | ✓         | null    | `{agency_id, agency_name}`            |
| `agency.join_request_rejected` | ✓         | null    | `{agency_id, agency_name}`            |
| `agency.member_kicked`         | ✓         | null    | `{agency_id, agency_name, reason}`    |
| `agency.dissolved`             | Multiple  | null    | `{agency_id, agency_name}`            |

### LOW Priority

| Event               | user_id | room_id | Payload          |
| ------------------- | ------- | ------- | ---------------- | -------- | ------- | ------- |
| `config:invalidate` | null    | null    | `{type: 'levels' | 'badges' | 'gifts' | 'all'}` |

---

## 6. MSAB Implementation Requirements

### 6.1. Redis Subscription

Subscribe to the channel on startup:

```javascript
// Node.js example using ioredis
const Redis = require("ioredis");

const redis = new Redis({
  host: process.env.MSAB_REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.MSAB_REDIS_PORT || "6379"),
  db: parseInt(process.env.MSAB_REDIS_DB || "3"),
});

redis.subscribe("flylive:msab:events", (err, count) => {
  if (err) {
    console.error("Failed to subscribe:", err);
    return;
  }
  console.log(`Subscribed to ${count} channel(s)`);
});

redis.on("message", (channel, message) => {
  if (channel === "flylive:msab:events") {
    handleLaravelEvent(JSON.parse(message));
  }
});
```

### 6.2. Event Router

```javascript
function handleLaravelEvent(event) {
  const { event: eventType, user_id, room_id, payload } = event;

  console.log(`Event: ${eventType}, user: ${user_id}, room: ${room_id}`);

  if (user_id && room_id) {
    // Send to specific user in room
    emitToUserInRoom(user_id, room_id, eventType, payload);
  } else if (room_id) {
    // Broadcast to entire room
    emitToRoom(room_id, eventType, payload);
  } else if (user_id) {
    // Private message to user
    emitToUser(user_id, eventType, payload);
  } else {
    // Broadcast to all
    emitToAll(eventType, payload);
  }
}
```

### 6.3. User Socket Tracking

MSAB needs to maintain a mapping of `user_id` → `socket_id(s)`:

```javascript
// Map: user_id -> Set of socket IDs
const userSockets = new Map();

// When user connects
function onUserConnect(socket, userId) {
  if (!userSockets.has(userId)) {
    userSockets.set(userId, new Set());
  }
  userSockets.get(userId).add(socket.id);
}

// When user disconnects
function onUserDisconnect(socket, userId) {
  const sockets = userSockets.get(userId);
  if (sockets) {
    sockets.delete(socket.id);
    if (sockets.size === 0) {
      userSockets.delete(userId);
    }
  }
}

// Send to user
function emitToUser(userId, event, payload) {
  const sockets = userSockets.get(userId);
  if (sockets) {
    for (const socketId of sockets) {
      io.to(socketId).emit(event, payload);
    }
  }
}
```

---

## 7. Testing

### 7.1. Manual Testing with redis-cli

Monitor events in real-time:

```bash
# Subscribe to channel
redis-cli -n 3 PSUBSCRIBE "flylive:msab:*"
```

Then trigger an action in the app (e.g., send a gift) and observe the event.

### 7.2. Publish Test Event

```bash
redis-cli -n 3 PUBLISH flylive:msab:events '{
  "event": "balance.updated",
  "user_id": 123,
  "room_id": null,
  "payload": {"coins": "1000", "diamonds": "50"},
  "timestamp": "2026-01-15T00:00:00Z",
  "correlation_id": "test-123"
}'
```

---

## 8. Environment Variables Reference

### Laravel Side (Already Configured)

```env
MSAB_REDIS_HOST=127.0.0.1
MSAB_REDIS_PORT=6379
MSAB_REDIS_DB=3
MSAB_EVENTS_CHANNEL=flylive:msab:events
MSAB_EVENTS_ENABLED=true
MSAB_INTERNAL_KEY=<shared-secret>
```

### MSAB Side (Configure These)

```env
MSAB_REDIS_HOST=127.0.0.1      # Same as Laravel
MSAB_REDIS_PORT=6379
MSAB_REDIS_DB=3                 # Must match Laravel
MSAB_EVENTS_CHANNEL=flylive:msab:events  # Must match Laravel
```

---

## 9. Checklist for MSAB Team

### Required Implementation

- [ ] Subscribe to `flylive:msab:events` Redis channel (database 3)
- [ ] Parse JSON event messages
- [ ] Maintain `user_id` → socket mapping for private events
- [ ] Maintain room membership for room events
- [ ] Implement event routing logic
- [ ] Handle all HIGH priority events (balance, badge, reward, income, room.level_up)
- [ ] Handle MEDIUM priority events (agency.\*)
- [ ] Handle LOW priority events (config:invalidate)

### Nice to Have

- [ ] Event logging/tracing using `correlation_id`
- [ ] Reconnection logic for Redis subscriber
- [ ] Dead letter queue for failed deliveries

---

## 10. Questions & Contact

### Original Questions from MSAB_REQUIREMENTS.md

| Question                                             | Answer                                            |
| ---------------------------------------------------- | ------------------------------------------------- |
| Current mechanism for Laravel → MSAB event emission? | Redis pub/sub via `EmitMSABEvent` job             |
| User socket tracking for private events?             | MSAB must implement this internally               |
| Timeline for implementation?                         | Laravel side complete; MSAB can begin immediately |

### Files to Reference

- [MSABEventService.php](file:///home/xha/FlyLive/backend-Laravel-12/app/Services/MSABEventService.php) - See all available event methods
- [EmitMSABEvent.php](file:///home/xha/FlyLive/backend-Laravel-12/app/Jobs/EmitMSABEvent.php) - See message format

---

## Appendix: Full Event Method Reference

From `MSABEventService.php`:

```php
// Balance & XP
emitBalanceUpdated(User $user)

// Badges
emitBadgeEarned(User $user, Badge $badge, string $context)

// Levels
emitLevelUp(User $user, string $type, int $oldLevel, int $newLevel)
emitRoomLevelUp(Room $room, int $oldLevel, int $newLevel)

// Income
emitIncomeTargetCompleted(AgencyIncomeTarget $target)

// Gifts
emitGiftSent(int $senderId, int $receiverId, int $roomId, ...)

// Agency
emitAgencyMemberJoined(int $agencyId, int $userId, int $ownerId)
emitAgencyMemberLeft(int $agencyId, int $userId, int $ownerId, string $reason)

// Room
emitRoomParticipantCountChanged(Room $room)
```
