# `gift:send` Event

> **Domain**: Gift  
> **Direction**: C→S  
> **Handler**: `src/domains/gift/giftHandler.ts`

---

## 1. Event Overview

### Event: `gift:send` (C→S)

### Purpose

Sends a virtual gift to a user in the room. Gifts are rate-limited, broadcast immediately for UI optimism, and batched to Laravel for database processing.

### Domain

**Gift** - Virtual gift transactions and animations

### Responsibilities

- Validate payload via Zod schema (inside `createHandler`)
- Room membership verification (inside `createHandler`)
- Enforce rate limiting per user/room
- Record auto-close activity
- Broadcast `gift:received` immediately (optimistic UI, flat payload)
- Queue gift for batched Laravel processing

### What It Owns

| Owned               | Description                       |
| ------------------- | --------------------------------- |
| Immediate broadcast | `gift:received` for animations    |
| Gift queuing        | Batched to Laravel via GiftBuffer |
| Rate limit state    | Redis tokens                      |

### External Dependencies

| Dependency         | Type    | Purpose                |
| ------------------ | ------- | ---------------------- |
| `RateLimiter`      | Redis   | Token bucket           |
| `AutoCloseService` | Redis   | Record room activity   |
| `GiftBuffer`       | Service | Batch queue to Laravel |
| `LaravelClient`    | HTTP    | Gift batch processing  |

---

## 2. Event Contract

### Inbound Event

```
Event: gift:send
Direction: C→S
Acknowledgment: ✅ Via createHandler ({ success: boolean, error?: string })
```

### Zod Schema

```typescript
// src/socket/schemas.ts
export const sendGiftSchema = z.object({
  roomId: roomIdSchema,
  giftId: z.number().int().positive(),
  recipientId: z.number().int().positive(),
  quantity: z.number().int().positive().max(9999).default(1),
});
```

### Payload Schema

```json
{
  "roomId": "string",
  "giftId": 1, // Gift type ID
  "recipientId": 123, // Recipient user ID
  "quantity": 1 // Number of gifts (default: 1)
}
```

### Emitted Events

| Event           | Target | When                         |
| --------------- | ------ | ---------------------------- |
| `gift:received` | Room   | Immediately after validation |

---

## 3. Event Execution Flow

### 3.1 Entry Point

```typescript
// Uses createHandler wrapper
const handleGiftSend = createHandler(
  "gift:send",
  sendGiftSchema,
  async (payload, socket, context) => { ... }
);
```

### 3.2 Rate Limiting

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ RATE LIMIT CHECK                                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│ Uses context.rateLimiter.consume() with config.GIFT_RATE_LIMIT              │
│ Returns { error: Errors.RATE_LIMITED } on failure                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Optimistic Broadcast

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ BROADCAST FLAT PAYLOAD TO ROOM                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ Broadcasts immediately for UI animations. Uses FLAT fields.                │
│                                                                             │
│ socket.nsp.in(roomId).emit("gift:received", {                               │
│   giftId,                                                                   │
│   senderId: socket.data.user.id,                                           │
│   senderName: socket.data.user.name,                                       │
│   senderAvatar: socket.data.user.avatar,                                   │
│   recipientId,                                                              │
│   quantity,                                                                 │
│   timestamp: Date.now(),                                                    │
│ });                                                                         │
│                                                                             │
│ NOTE: No nested sender/recipient objects. Flat fields only.                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Queue for Laravel

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ BATCH QUEUE                                                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ Gift is added to GiftBuffer. Buffer flushes to Laravel every 100ms or      │
│ when batch reaches threshold (10 gifts).                                    │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ giftHandler.queue({                                                     │ │
│ │   senderId: socket.data.user.id,                                        │ │
│ │   recipientId,                                                          │ │
│ │   giftId,                                                               │ │
│ │   quantity,                                                             │ │
│ │   roomId,                                                               │ │
│ │ });                                                                     │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. State Transitions

### Redis State

| Key Pattern                        | Operation         |
| ---------------------------------- | ----------------- |
| `ratelimit:gift:{userId}:{roomId}` | Token decremented |

### GiftBuffer (In-Memory)

| Operation | Effect                      |
| --------- | --------------------------- |
| `queue()` | Gift added to pending batch |

---

## 5. Related Events

| Event             | Relationship                     |
| ----------------- | -------------------------------- |
| `gift:prepare`    | Preload signal (no processing)   |
| `gift:received`   | Broadcast output                 |
| `balance.updated` | Laravel pub/sub after processing |

---

## 6. Cross-Platform Integration

### Frontend Usage (Nuxt)

```typescript
// composables/useGift.ts
const sendGift = async (roomId: string, giftId: number, recipientId: number) => {
  const response = await socket.emitWithAck("gift:send", {
    roomId,
    giftId,
    recipientId,
    quantity: 1,
  });
  if (!response.success) console.error(response.error);
};

// Listen for broadcasts (flat payload)
socket.on("gift:received", (gift) => {
  // gift = { giftId, senderId, senderName, senderAvatar, recipientId, quantity, timestamp }
  playGiftAnimation(gift.giftId);
});

### Laravel Integration

| Endpoint                     | When Called             | Purpose                   |
| ---------------------------- | ----------------------- | ------------------------- |
| `POST /internal/gifts/batch` | Every 100ms or 10 gifts | Process gift transactions |

---

## 7. Document Metadata

| Property         | Value                                  |
| ---------------- | -------------------------------------- |
| **Event**        | `gift:send`                            |
| **Domain**       | Gift                                   |
| **Direction**    | C→S                                    |
| **Created**      | 2026-02-09                             |
| **Last Updated** | 2026-02-12                             |
| **Handler**      | `src/domains/gift/giftHandler.ts`      |

### Schema Change Log

| Date       | Change                                                      |
| ---------- | ----------------------------------------------------------- |
| 2026-02-12 | `quantity` constraint: added `.max(9999)`                    |
| 2026-02-12 | Broadcast payload changed to flat fields (no nested sender) |
| 2026-02-12 | Handler changed to `createHandler` pattern (ACK support)    |
| 2026-02-12 | Added `autoCloseService.recordActivity()` call              |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
```
