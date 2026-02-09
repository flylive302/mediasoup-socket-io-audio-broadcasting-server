# Event: `seat:invite:pending`

> **Domain**: Seat  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `seat:invite`, `seat:invite:accept`, `seat:invite:decline`

---

## 1. Event Overview

### Purpose

Notifies room about seat invitation status (pending or cleared).

### Key Characteristics

| Property     | Value                                                  |
| ------------ | ------------------------------------------------------ |
| Target       | All sockets in room                                    |
| Emitted From | `invite-seat.handler.ts`, `invite-response.handler.ts` |

---

## 2. Event Payload

```typescript
{
  seatIndex: number,
  isPending: boolean,
  invitedUserId?: number   // Only when isPending = true
}
```

---

## 3. Document Metadata

| Property | Value                                                  |
| -------- | ------------------------------------------------------ |
| Created  | 2026-02-09                                             |
| Sources  | `invite-seat.handler.ts`, `invite-response.handler.ts` |
