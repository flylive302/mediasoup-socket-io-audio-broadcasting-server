# Event: `gift:prepare`

> **Domain**: Gift  
> **Direction**: Client → Server → Room  
> **Transport**: Socket.IO (Fire-and-forget)  
> **Related Events**: `gift:send`, `gift:received`

---

## 1. Event Overview

### Purpose

Signals room members to preload a gift animation asset before the gift is actually sent.

### Business Context

Improves UX by allowing recipients to pre-cache gift animations, reducing perceived latency when the gift is actually sent.

### Key Characteristics

| Property                | Value                  |
| ----------------------- | ---------------------- |
| Requires Authentication | Yes (via middleware)   |
| Has Acknowledgment      | No (best-effort)       |
| Broadcasts              | `gift:prepare` to room |
| Rate Limited            | No                     |
| Failure Mode            | Silent fail            |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `prepareGiftSchema`  
**Source**: `src/socket/schemas.ts:190-194`

```typescript
{
  roomId: string,       // Room ID
  giftId: number,       // Gift ID to preload
  recipientId: number   // Intended recipient
}
```

### 2.2 Broadcast Event

**Event**: `gift:prepare`

```typescript
{
  giftId: number,       // Gift ID to preload
  recipientId: number   // Recipient should act on this
}
```

---

## 3. Event Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Validate payload (silent fail if invalid)                                │
│ 2. Broadcast gift:prepare to all room members                               │
│ 3. Recipients filter by recipientId and preload if matching                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Design Note

Broadcasts to entire room for simplicity - only the intended recipient should act on the preload signal.

---

## 4. Document Metadata

| Property | Value                             |
| -------- | --------------------------------- |
| Created  | 2026-02-09                        |
| Handler  | `src/domains/gift/giftHandler.ts` |
| Lines    | 77-93                             |
| Schema   | `src/socket/schemas.ts:190-194`   |
