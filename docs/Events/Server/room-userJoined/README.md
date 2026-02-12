# Event: `room:userJoined`

> **Domain**: Room  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `room:join`

---

## 1. Event Overview

### Purpose

Notifies all room members when a new user joins the room.

### Key Characteristics

| Property     | Value                               |
| ------------ | ----------------------------------- |
| Target       | All sockets in room (except sender) |
| Emitted From | `room.handler.ts:178`               |

---

## 2. Event Payload

```typescript
{
  userId: number,
  name: string,
  avatar: string,
  signature: string,
  frame: object | null,
  gender: number,
  country: string,
  wealth_xp: number,
  charm_xp: number
}
```

---

## 3. Document Metadata

| Property | Value                                  |
| -------- | -------------------------------------- |
| Created  | 2026-02-09                             |
| Source   | `src/domains/room/room.handler.ts:178` |
