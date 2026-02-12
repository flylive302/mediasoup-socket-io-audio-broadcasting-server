# Event: `gift:prepare`

> **Domain**: Gift  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `gift:send`, `gift:received`

---

## 1. Event Overview

### Purpose

Signals the intended recipient to preload a gift animation asset before the gift is actually sent.

### Business Context

Improves UX by allowing the recipient to pre-cache gift animations, reducing perceived latency when the gift arrives.

### Key Characteristics

| Property                | Value                            |
| ----------------------- | -------------------------------- |
| Requires Authentication | Yes (via middleware)             |
| Has Acknowledgment      | Yes (`createHandler`)            |
| Broadcasts              | `gift:prepare` to recipient only |
| Rate Limited            | Yes (GF-004)                     |
| Room Verified           | Yes (GF-001)                     |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `prepareGiftSchema`  
**Source**: [`schemas.ts`](file:///home/xha/FlyLive/mediasoup-socket-io-audio-broadcasting-server/src/socket/schemas.ts)

```typescript
{
  roomId: string,       // Room ID
  giftId: number,       // Gift ID to preload
  recipientId: number   // Intended recipient
}
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
  error: "NOT_IN_ROOM" | "RATE_LIMITED" | "INVALID_PAYLOAD"
}
```

### 2.4 Broadcast Event (Server → Recipient)

**Event**: `gift:prepare`  
**Target**: Recipient's sockets only (GF-005: targeted emit, not room broadcast)

```typescript
{
  giftId: number,       // Gift ID to preload
  recipientId: number   // Recipient user ID
}
```

---

## 3. Event Execution Flow

```
┌─────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                               │
├─────────────────────────────────────────────────────────────┤
│ 1. createHandler validates payload with prepareGiftSchema    │
│ 2. GF-001: Verify sender is in the target room              │
│ 3. GF-004/GF-009: Rate-limit check via shared rateLimiter   │
│ 4. GF-005: Look up recipient socket IDs                     │
│ 5. Targeted emit gift:prepare to recipient sockets only     │
│ 6. Return { success: true }                                  │
└─────────────────────────────────────────────────────────────┘
```

### Design Note

GF-005: Previously broadcast to the entire room. Now uses targeted emit to the recipient's sockets only, saving bandwidth on N-2 uninvolved clients.

---

## 4. Document Metadata

| Property         | Value                             |
| ---------------- | --------------------------------- |
| **Created**      | 2026-02-09                        |
| **Last Updated** | 2026-02-12                        |
| **Handler**      | `src/domains/gift/giftHandler.ts` |
| **Schema**       | `src/socket/schemas.ts`           |

### Schema Change Log

| Date       | Change                                                        |
| ---------- | ------------------------------------------------------------- |
| 2026-02-12 | Migrated to `createHandler` (CQ-001)                          |
| 2026-02-12 | GF-001: Added room verification                               |
| 2026-02-12 | GF-004: Added rate limiting                                   |
| 2026-02-12 | GF-005: Changed from room broadcast → targeted recipient emit |
| 2026-02-12 | Now returns ACK `{ success }` envelope                        |

---

_Documentation generated following [MSAB Documentation Standard v2.0](../../../DOCUMENTATION_STANDARD.md)_
