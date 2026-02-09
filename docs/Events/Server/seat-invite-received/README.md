# Event: `seat:invite:received`

> **Domain**: Seat  
> **Direction**: Server → Specific User  
> **Transport**: Socket.IO  
> **Triggered By**: `seat:invite`

---

## 1. Event Overview

### Purpose

Sends a seat invitation directly to the invited user's sockets.

### Key Characteristics

| Property     | Value                                           |
| ------------ | ----------------------------------------------- |
| Target       | Only target user's sockets (not room broadcast) |
| Emitted From | `invite-seat.handler.ts:141`                    |

---

## 2. Event Payload

```typescript
{
  seatIndex: number,
  invitedBy: {
    id: number,
    name: string
  },
  expiresAt: number,    // Unix timestamp (30s from now)
  targetUserId: number
}
```

---

## 3. Document Metadata

| Property | Value                                                  |
| -------- | ------------------------------------------------------ |
| Created  | 2026-02-09                                             |
| Source   | `src/domains/seat/handlers/invite-seat.handler.ts:141` |
