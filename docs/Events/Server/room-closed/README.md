# Event: `room:closed`

> **Domain**: Room  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: Room cleanup (no active participants)

---

## 1. Event Overview

### Purpose

Notifies all room members when a room is being closed.

### Key Characteristics

| Property     | Value                |
| ------------ | -------------------- |
| Target       | All sockets in room  |
| Emitted From | `roomManager.ts:119` |

---

## 2. Event Payload

```typescript
{
  reason: string;
}
```

---

## 3. Document Metadata

| Property | Value                                 |
| -------- | ------------------------------------- |
| Created  | 2026-02-09                            |
| Source   | `src/domains/room/roomManager.ts:119` |
