# Event: `audio:selfUnmute`

> **Domain**: Media  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `audio:selfMute`, `seat:userMuted` (broadcast)

---

## 1. Event Overview

### Purpose

Allows a user to unmute their own audio by resuming their producer server-side, restarting all downstream consumers.

### Business Context

Restores the user's audio after self-muting. Uses the same `selfMuteSchema` as `audio:selfMute`.

### Key Characteristics

| Property                | Value                                   |
| ----------------------- | --------------------------------------- |
| Requires Authentication | Yes (via middleware)                    |
| Has Acknowledgment      | Yes (via createHandler)                 |
| Broadcasts              | `seat:userMuted` to room                |
| Ownership Check         | RT-LOW-001: Verifies producer ownership |
| Server Enforcement      | Resumes producer at mediasoup level     |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `selfMuteSchema` (same as selfMute)  
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
  isMuted: false,
  selfMuted: true    // Distinguishes self-unmute from owner-unmute
}
```

---

## 3. Event Execution Flow

### 3.1 Entry Point

```typescript
const selfUnmuteHandler = createHandler(
  "audio:selfUnmute",
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
│ 4. Resume producer: await producer.resume()                                 │
│ 5. Broadcast seat:userMuted { userId, isMuted: false, selfMuted: true }    │
│ 6. Return { success: true }                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Document Metadata

| Property         | Value                                |
| ---------------- | ------------------------------------ |
| **Event**        | `audio:selfUnmute`                   |
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
