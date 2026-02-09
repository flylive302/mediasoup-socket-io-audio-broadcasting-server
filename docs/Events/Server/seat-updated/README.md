# Event: `seat:updated`

> **Domain**: Seat  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `seat:take`, `seat:assign`, `seat:invite:accept`

---

## 1. Event Overview

### Purpose

Notifies room when a seat is taken by a user (includes user details).

### Key Characteristics

| Property     | Value               |
| ------------ | ------------------- |
| Target       | All sockets in room |
| Emitted From | Multiple handlers   |

---

## 2. Event Payload

```typescript
{
  seatIndex: number,
  user: {
    id: number,
    name: string,
    avatar: string,
    signature: string,
    frame: object | null,
    gender: string,
    country: string,
    wealth_xp: number,
    charm_xp: number
  },
  isMuted: boolean
}
```

---

## 3. Document Metadata

| Property | Value                                                                          |
| -------- | ------------------------------------------------------------------------------ |
| Created  | 2026-02-09                                                                     |
| Sources  | `take-seat.handler.ts`, `assign-seat.handler.ts`, `invite-response.handler.ts` |
