# Event: `room:userLeft`

> **Domain**: Room  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `room:leave`, disconnect

---

## 1. Event Overview

### Purpose

Notifies all room members when a user leaves the room.

### Key Characteristics

| Property     | Value                                        |
| ------------ | -------------------------------------------- |
| Target       | All sockets in room                          |
| Emitted From | `room.handler.ts:243`, `socket/index.ts:188` |

---

## 2. Event Payload

```typescript
{
  userId: number;
}
```

---

## 3. Document Metadata

| Property | Value                                  |
| -------- | -------------------------------------- |
| Created  | 2026-02-09                             |
| Source   | `src/domains/room/room.handler.ts:243` |
