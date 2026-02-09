# `chat:message` Event

> **Domain**: Chat  
> **Direction**: C→S  
> **Handler**: `src/domains/chat/chat.handler.ts`

---

## 1. Event Overview

### Event: `chat:message` (C→S)

### Purpose

Sends a chat message in a room with rate limiting. Broadcasts to all participants including the sender.

### Domain

**Chat** - Real-time messaging within rooms

### Responsibilities

- Validate payload via Zod schema
- Enforce rate limiting (Redis-backed)
- Enrich message with sender data
- Broadcast to all room participants (including sender)

### What It Owns

| Owned               | Description              |
| ------------------- | ------------------------ |
| Message broadcast   | Delivers message to room |
| Rate limit tracking | Redis tokens for user    |

### External Dependencies

| Dependency    | Type  | Purpose                    |
| ------------- | ----- | -------------------------- |
| `RateLimiter` | Redis | Token bucket rate limiting |

---

## 2. Event Contract

### Inbound Event

```
Event: chat:message
Direction: C→S
Acknowledgment: ❌ Not used
```

### Zod Schema

```typescript
// src/socket/schemas.ts:173-177
export const chatMessageSchema = z.object({
  roomId: roomIdSchema,
  content: z.string().min(1).max(500),
  type: z.string().optional(),
});
```

### Payload Schema

```json
{
  "roomId": "string",
  "content": "string",
  "type": "string" // Optional, message type
}
```

### Field Details

| Field     | Type     | Required | Constraints | Example    |
| --------- | -------- | -------- | ----------- | ---------- |
| `roomId`  | `string` | ✅       | min 1 char  | `"42"`     |
| `content` | `string` | ✅       | 1-500 chars | `"Hello!"` |
| `type`    | `string` | ❌       | Optional    | `"text"`   |

### Emitted Events

| Event          | Target                  | When                             |
| -------------- | ----------------------- | -------------------------------- |
| `chat:message` | Room (INCLUDING sender) | After validation & rate limiting |

---

## 3. Event Execution Flow

### 3.1 Entry Point

```typescript
socket.on("chat:message", async (rawPayload: unknown) => {
  // Handler logic - no acknowledgment
});
```

### 3.2 Validation & Rate Limiting

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ VALIDATE & CHECK RATE LIMIT                                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ 1. Zod schema validation                                                    │
│ 2. Rate limit check via Redis (tokens per user per room)                    │
│                                                                             │
│ Silently drops message if:                                                  │
│ • Payload invalid                                                           │
│ • Rate limit exceeded                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Broadcast

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ BROADCAST TO ROOM                                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ Uses io.to() not socket.to() - includes sender for state consistency.      │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ io.to(roomId).emit("chat:message", {                                    │ │
│ │   content,                                                              │ │
│ │   type,                                                                 │ │
│ │   user: {                                                               │ │
│ │     id: socket.data.user.id,                                            │ │
│ │     name: socket.data.user.name,                                        │ │
│ │     avatar: socket.data.user.avatar,                                    │ │
│ │     ...                                                                 │ │
│ │   },                                                                    │ │
│ │   timestamp: Date.now(),                                                │ │
│ │ });                                                                     │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. State Transitions

### Redis State

| Key Pattern                        | Operation         |
| ---------------------------------- | ----------------- |
| `ratelimit:chat:{userId}:{roomId}` | Token decremented |

---

## 5. Error Handling & Edge Cases

| Scenario            | Behavior                                   |
| ------------------- | ------------------------------------------ |
| Invalid payload     | Silently ignored                           |
| Rate limit exceeded | Silently dropped                           |
| User not in room    | Still broadcasts (user may have re-joined) |
| Empty content       | Rejected by Zod (min 1)                    |
| Content > 500 chars | Rejected by Zod                            |

---

## 6. Sequence Diagram

```
 CLIENT          SOCKET.IO          HANDLER          RATE_LIMITER      ROOM
   │                  │                  │                │              │
   │  chat:message    │                  │                │              │
   │─────────────────▶│                  │                │              │
   │                  │ 1. dispatch      │                │              │
   │                  │─────────────────▶│                │              │
   │                  │                  │ 2. validate    │              │
   │                  │                  │ 3. checkLimit  │              │
   │                  │                  │───────────────▶│              │
   │                  │                  │◀───────────────│ allowed      │
   │                  │                  │                │              │
   │                  │ 4. chat:message (to ALL in room)  │              │
   │◀─────────────────│──────────────────────────────────────────────────▶
```

---

## 7. Cross-Platform Integration

### Frontend Usage (Nuxt)

```typescript
// composables/useChat.ts
const sendMessage = (roomId: string, content: string) => {
  socket.emit("chat:message", { roomId, content });
};

socket.on("chat:message", (message) => {
  messages.value.push(message);
});
```

---

## 8. Document Metadata

| Property      | Value          |
| ------------- | -------------- |
| **Event**     | `chat:message` |
| **Domain**    | Chat           |
| **Direction** | C→S            |
| **Created**   | 2026-02-09     |

---

_Documentation generated following [MSAB Documentation Standard](../../DOCUMENTATION_STANDARD.md)_
