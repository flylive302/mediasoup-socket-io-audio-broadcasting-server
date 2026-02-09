# Event: `seat:userMuted`

> **Domain**: Seat  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `seat:mute`, `seat:unmute`

---

## 1. Event Overview

### Purpose

Notifies room when a user's mute status changes.

### Key Characteristics

| Property     | Value                                            |
| ------------ | ------------------------------------------------ |
| Target       | All sockets in room (including sender)           |
| Emitted From | `mute-seat.handler.ts`, `unmute-seat.handler.ts` |

---

## 2. Event Payload

```typescript
{
  userId: number,
  isMuted: boolean   // true = muted, false = unmuted
}
```

---

## 3. Document Metadata

| Property | Value                                            |
| -------- | ------------------------------------------------ |
| Created  | 2026-02-09                                       |
| Sources  | `mute-seat.handler.ts`, `unmute-seat.handler.ts` |
