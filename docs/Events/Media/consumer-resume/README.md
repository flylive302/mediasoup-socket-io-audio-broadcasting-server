# Event: `consumer:resume`

> **Domain**: Media  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `audio:consume` (prerequisite)

---

## 1. Event Overview

### Purpose

Resumes a paused consumer to start receiving media data from a producer.

### Business Context

Consumers are created paused by `audio:consume` for flow control. Once the client sets up its local media track, it calls `consumer:resume` to begin receiving audio. Includes an active speaker forwarding optimization that defers resume for inactive speakers.

### Key Characteristics

| Property                | Value                                         |
| ----------------------- | --------------------------------------------- |
| Requires Authentication | Yes (via middleware)                          |
| Has Acknowledgment      | Yes (via createHandler)                       |
| Broadcasts              | No                                            |
| Active Speaker Opt.     | Defers resume if source speaker is not active |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `consumerResumeSchema`  
**Source**: `src/socket/schemas.ts`

```typescript
export const consumerResumeSchema = z.object({
  roomId: roomIdSchema,
  consumerId: z.string(),
});
```

### 2.2 Acknowledgment (Success)

```typescript
{ success: true }
// OR
{ success: true, data: { deferred: true } }  // Speaker not active — will auto-resume later
```

### 2.3 Acknowledgment (Error)

```typescript
{
  success: false,
  error: "INVALID_PAYLOAD" | "Room not found" | "Consumer not found" | "INTERNAL_ERROR"
}
```

---

## 3. Event Execution Flow

### 3.1 Entry Point

```typescript
const consumerResumeHandler = createHandler(
  "consumer:resume",
  consumerResumeSchema,
  async (payload, _socket, context) => { ... }
);
```

### 3.2 Execution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. createHandler validates payload + room membership                        │
│ 2. Look up room cluster + consumer                                          │
│ 3. ACTIVE SPEAKER CHECK:                                                    │
│    a. Get sourceProducerId from consumer.appData                            │
│    b. If source producer is NOT an active speaker:                          │
│       → Return { success: true, data: { deferred: true } }                 │
│       → Consumer auto-resumes when speaker becomes active                  │
│ 4. If active (or no speaker check needed):                                  │
│    → await consumer.resume()                                                │
│ 5. Return { success: true }                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Active Speaker Forwarding Optimization

For large rooms, consumers are only resumed when the source speaker is currently active. This reduces bandwidth for silent speakers:

```typescript
const sourceProducerId = consumer.appData.sourceProducerId as
  | string
  | undefined;
if (sourceProducerId && !cluster.isActiveSpeaker(sourceProducerId)) {
  return { success: true, data: { deferred: true } };
}
```

---

## 4. Document Metadata

| Property         | Value                                |
| ---------------- | ------------------------------------ |
| **Event**        | `consumer:resume`                    |
| **Domain**       | Media                                |
| **Direction**    | C→S                                  |
| **Created**      | 2026-02-09                           |
| **Last Updated** | 2026-02-12                           |
| **Handler**      | `src/domains/media/media.handler.ts` |

### Schema Change Log

| Date       | Change                                                    |
| ---------- | --------------------------------------------------------- |
| 2026-02-12 | Handler migrated to `createHandler` pattern (CQ-001)      |
| 2026-02-12 | Added active speaker forwarding optimization (deferred)   |
| 2026-02-12 | ACK can return `{ deferred: true }` for inactive speakers |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
