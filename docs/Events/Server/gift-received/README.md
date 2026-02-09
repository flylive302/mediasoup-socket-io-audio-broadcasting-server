# Event: `gift:received`

> **Domain**: Gift  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `gift:send`

---

## 1. Event Overview

### Purpose

Broadcasts gift to all room members (optimistic UI - sent immediately, processed async).

### Key Characteristics

| Property     | Value                               |
| ------------ | ----------------------------------- |
| Target       | All sockets in room (except sender) |
| Emitted From | `giftHandler.ts:64`                 |

---

## 2. Event Payload

```typescript
{
  senderId: number,
  senderName: string,
  senderAvatar: string,
  roomId: string,
  recipientId: number,
  giftId: number,
  quantity: number
}
```

---

## 3. Document Metadata

| Property | Value                                |
| -------- | ------------------------------------ |
| Created  | 2026-02-09                           |
| Source   | `src/domains/gift/giftHandler.ts:64` |
