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

- Validate payload via Zod schema
- Enforce rate limiting per user/room
- Broadcast `gift:received` immediately (optimistic UI)
- Queue gift for batched Laravel processing

### What It Owns

| Owned               | Description                       |
| ------------------- | --------------------------------- |
| Immediate broadcast | `gift:received` for animations    |
| Gift queuing        | Batched to Laravel via GiftBuffer |
| Rate limit state    | Redis tokens                      |

### External Dependencies

| Dependency      | Type    | Purpose                |
| --------------- | ------- | ---------------------- |
| `RateLimiter`   | Redis   | Token bucket           |
| `GiftBuffer`    | Service | Batch queue to Laravel |
| `LaravelClient` | HTTP    | Gift batch processing  |

---

## 2. Event Contract

### Inbound Event

```
Event: gift:send
Direction: C→S
Acknowledgment: ❌ Not used
```

### Zod Schema

```typescript
// src/socket/schemas.ts:183-188
export const sendGiftSchema = z.object({
  roomId: roomIdSchema,
  giftId: z.number().int().positive(),
  recipientId: z.number().int().positive(),
  quantity: z.number().int().positive().default(1),
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

### 3.1 Validation & Rate Limiting

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ VALIDATE & RATE LIMIT                                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ 1. Zod validation (giftId, recipientId must be positive)                    │
│ 2. Rate limit check (more restrictive than chat)                            │
│                                                                             │
│ Silently drops if rate limited.                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Optimistic Broadcast

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ IMMEDIATE BROADCAST                                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ Broadcasts immediately for UI animations before Laravel confirms.           │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ io.to(roomId).emit("gift:received", {                                   │ │
│ │   giftId,                                                               │ │
│ │   sender: { id, name, avatar },                                         │ │
│ │   recipient: { id: recipientId },                                       │ │
│ │   quantity,                                                             │ │
│ │   timestamp: Date.now(),                                                │ │
│ │ });                                                                     │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
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
const sendGift = (roomId: string, giftId: number, recipientId: number) => {
  socket.emit("gift:send", { roomId, giftId, recipientId, quantity: 1 });
};

socket.on("gift:received", (gift) => {
  playGiftAnimation(gift.giftId);
});
```

### Laravel Integration

| Endpoint                     | When Called             | Purpose                   |
| ---------------------------- | ----------------------- | ------------------------- |
| `POST /internal/gifts/batch` | Every 100ms or 10 gifts | Process gift transactions |

---

## 7. Document Metadata

| Property      | Value       |
| ------------- | ----------- |
| **Event**     | `gift:send` |
| **Domain**    | Gift        |
| **Direction** | C→S         |
| **Created**   | 2026-02-09  |

---

_Documentation generated following [MSAB Documentation Standard](../../DOCUMENTATION_STANDARD.md)_
