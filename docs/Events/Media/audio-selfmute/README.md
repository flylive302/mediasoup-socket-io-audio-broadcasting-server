# Event: `audio:selfMute`

> **Domain**: Media  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `audio:selfUnmute`, `seat:userMuted` (broadcast)

---

## 1. Event Overview

### Purpose

Allows a user to mute their own audio by pausing their producer server-side, stopping all downstream consumers.

### Business Context

Self-muting differs from owner-muting (`seat:mute`): the user controls their own mic. Server-side pause ensures silence is enforced at the mediasoup level, not just the client.

### Key Characteristics

| Property                | Value                                   |
| ----------------------- | --------------------------------------- |
| Requires Authentication | Yes (via middleware)                    |
| Has Acknowledgment      | Yes (via createHandler)                 |
| Broadcasts              | `seat:userMuted` to room                |
| Ownership Check         | RT-LOW-001: Verifies producer ownership |
| Server Enforcement      | Pauses producer at mediasoup level      |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `selfMuteSchema`  
**Source**: `src/socket/schemas.ts`

```typescript
export const selfMuteSchema = z.object({
  roomId: roomIdSchema,
  producerId: z.string(),
});
```

### 2.2 Acknowledgment (Success)

```typescript
{
  success: true;
}
```

### 2.3 Acknowledgment (Error)

```typescript
{
  success: false,
  error: "INVALID_PAYLOAD" | "Producer not found" | "Not your producer" | "INTERNAL_ERROR"
}
```

### 2.4 Broadcast Event

**Event**: `seat:userMuted` (to room via `socket.to(roomId)`)

```typescript
{
  userId: number,
  isMuted: true,
  selfMuted: true    // Distinguishes self-mute from owner-mute
}
```

---

## 3. Event Execution Flow

### 3.1 Entry Point

```typescript
const selfMuteHandler = createHandler(
  "audio:selfMute",
  selfMuteSchema,
  async (payload, socket, context) => { ... }
);
```

### 3.2 Execution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. createHandler validates payload + room membership                        │
│ 2. Look up room cluster + producer                                          │
│ 3. RT-LOW-001: Verify producer.appData.userId === socket.data.user.id      │
│ 4. Pause producer: await producer.pause()                                   │
│ 5. Broadcast seat:userMuted { userId, isMuted: true, selfMuted: true }     │
│ 6. Return { success: true }                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Document Metadata

| Property         | Value                                |
| ---------------- | ------------------------------------ |
| **Event**        | `audio:selfMute`                     |
| **Domain**       | Media                                |
| **Direction**    | C→S                                  |
| **Created**      | 2026-02-12                           |
| **Last Updated** | 2026-02-12                           |
| **Handler**      | `src/domains/media/media.handler.ts` |

### Schema Change Log

| Date       | Change                |
| ---------- | --------------------- |
| 2026-02-12 | Initial documentation |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
