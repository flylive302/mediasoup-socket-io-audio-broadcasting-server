# Event: `user:getRoom`

> **Domain**: User  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: None

---

## 1. Event Overview

### Purpose

Returns the room ID that a specific user is currently in.

### Business Context

Used for the "Track" feature on user profile pages, allowing users to find and join a friend's room.

### Key Characteristics

| Property                | Value                                   |
| ----------------------- | --------------------------------------- |
| Requires Authentication | Yes (via middleware)                    |
| Has Acknowledgment      | Yes                                     |
| Broadcasts              | No                                      |
| Rate Limited            | No                                      |
| Handler Pattern         | Raw `socket.on()` (not `createHandler`) |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `getUserRoomSchema`  
**Source**: [`schemas.ts`](file:///home/xha/FlyLive/mediasoup-socket-io-audio-broadcasting-server/src/socket/schemas.ts)

```typescript
{
  userId: number; // User ID to look up
}
```

### 2.2 Acknowledgment (Success)

```typescript
{
  roomId: string | null; // Room ID if user is in a room, null otherwise
}
```

### 2.3 Acknowledgment (Error)

```typescript
{
  roomId: null,
  error: "INVALID_PAYLOAD" | "INTERNAL_ERROR"   // Uses Errors constants
}
```

---

## 3. Event Execution Flow

```
┌─────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                               │
├─────────────────────────────────────────────────────────────┤
│ 1. Validate payload with getUserRoomSchema.safeParse()       │
│ 2. On validation failure: ACK { roomId: null, error }        │
│ 3. Query Redis via userSocketRepository.getUserRoom(userId)  │
│ 4. Return { roomId } (or null if not in a room)              │
│ 5. On error: ACK { roomId: null, error: INTERNAL_ERROR }     │
└─────────────────────────────────────────────────────────────┘
```

### Design Note

This handler uses raw `socket.on()` instead of `createHandler` because it predates the handler utility and has a non-standard ACK shape (`{ roomId, error }` vs `{ success, error }`).

---

## 4. Document Metadata

| Property         | Value                              |
| ---------------- | ---------------------------------- |
| **Created**      | 2026-02-09                         |
| **Last Updated** | 2026-02-12                         |
| **Handler**      | `src/domains/user/user.handler.ts` |
| **Schema**       | `src/socket/schemas.ts`            |

### Schema Change Log

| Date       | Change                                                 |
| ---------- | ------------------------------------------------------ |
| 2026-02-12 | Noted raw `socket.on()` pattern and `Errors` constants |
| 2026-02-12 | Updated source references and added execution flow     |

---

_Documentation generated following [MSAB Documentation Standard v2.0](../../../DOCUMENTATION_STANDARD.md)_
