# `chat:message` Event

> **Domain**: Chat  
> **Direction**: C→S  
> **Handler**: `src/domains/chat/chat.handler.ts:9-60`

---

## 1. Event Overview

### Event: `chat:message` (C→S)

### Purpose

Sends a chat message in a room with rate limiting. Broadcasts to all participants including the sender.

### Domain

**Chat** - Real-time messaging within rooms

### Responsibilities

- Validate payload via Zod schema (inside `createHandler`)
- Room membership verification (inside `createHandler`)
- Enforce rate limiting (Redis-backed)
- Generate UUID for each message
- Record auto-close activity
- Broadcast flat message payload to ALL room members (including sender)

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
Acknowledgment: ✅ Via createHandler ({ success: boolean, error?: string })
```

### Zod Schema

```typescript
// src/socket/schemas.ts
export const chatMessageSchema = z.object({
  roomId: roomIdSchema,
  content: z.string().min(1).max(500),
  type: z.enum(["text", "emoji", "sticker", "gift", "system"]).default("text"),
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

| Field     | Type     | Required | Constraints                                          | Example    |
| --------- | -------- | -------- | ---------------------------------------------------- | ---------- |
| `roomId`  | `string` | ✅       | min 1 char                                           | `"42"`     |
| `content` | `string` | ✅       | 1-500 chars                                          | `"Hello!"` |
| `type`    | `enum`   | ❌       | `text\|emoji\|sticker\|gift\|system`, default `text` | `"text"`   |

### Emitted Events

| Event          | Target                  | When                             |
| -------------- | ----------------------- | -------------------------------- |
| `chat:message` | Room (INCLUDING sender) | After validation & rate limiting |

---

## 3. Event Execution Flow

### 3.1 Entry Point

```typescript
// Uses createHandler wrapper for consistent validation, error handling, and ACK
const handleChatMessage = createHandler(
  "chat:message",
  chatMessageSchema,
  async (payload, socket, context) => { ... }
);
```

### 3.2 Rate Limiting

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ RATE LIMIT CHECK                                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: chat.handler.ts:14-20                                                 │
│                                                                             │
│ Uses context.rateLimiter.consume() with config.CHAT_RATE_LIMIT              │
│ Returns { error: Errors.RATE_LIMITED } on failure                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Build & Broadcast

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ BUILD FLAT MESSAGE + BROADCAST TO ROOM                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: chat.handler.ts:22-49                                                 │
│                                                                             │
│ 1. Generate UUID: id = randomUUID()                                        │
│ 2. Build FLAT message object:                                              │
│    { id, userId, userName, avatar, content, type, timestamp }              │
│ 3. Record auto-close activity                                              │
│ 4. socket.nsp.in(roomId).emit("chat:message", message)                     │
│    → Uses nsp.in() to include sender                                       │
│                                                                             │
│ NOTE: Payload uses flat fields, NOT a nested `user` object.                │
│ This was changed during the Chat remediation.                              │
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

| Scenario            | Behavior                                            |
| ------------------- | --------------------------------------------------- |
| Invalid payload     | `createHandler` returns `{ success: false, error }` |
| Rate limit exceeded | Returns `{ error: Errors.RATE_LIMITED }`            |
| Not in room         | `createHandler` checks membership, returns error    |
| Empty content       | Rejected by Zod (min 1)                             |
| Content > 500 chars | Rejected by Zod                                     |

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
const sendMessage = async (roomId: string, content: string) => {
  const response = await socket.emitWithAck("chat:message", {
    roomId,
    content,
    type: "text",
  });
  if (!response.success) console.error(response.error);
};

// Listen for broadcasts (flat payload)
socket.on("chat:message", (message) => {
  // message = { id, userId, userName, avatar, content, type, timestamp }
  messages.value.push(message);
});
```

---

## 8. Document Metadata

| Property         | Value                              |
| ---------------- | ---------------------------------- |
| **Event**        | `chat:message`                     |
| **Domain**       | Chat                               |
| **Direction**    | C→S                                |
| **Created**      | 2026-02-09                         |
| **Last Updated** | 2026-02-12                         |
| **Handler**      | `src/domains/chat/chat.handler.ts` |

### Schema Change Log

| Date       | Change                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| 2026-02-12 | `type` changed from `z.string().optional()` → `z.enum(["text","emoji","sticker","gift","system"]).default("text")` |
| 2026-02-12 | Broadcast payload changed from nested `user` object → flat fields (`userId`, `userName`, `avatar`)                 |
| 2026-02-12 | Handler changed to `createHandler` pattern (ACK support)                                                           |
| 2026-02-12 | Added `autoCloseService.recordActivity()` call                                                                     |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
