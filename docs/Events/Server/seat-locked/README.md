# Event: `seat:locked`

> **Domain**: Seat  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `seat:lock`, `seat:unlock`, `seat:invite:accept`

---

## 1. Event Overview

### Purpose

Notifies room when a seat is locked or unlocked.

### Key Characteristics

| Property     | Value                                            |
| ------------ | ------------------------------------------------ |
| Target       | All sockets in room                              |
| Emitted From | `lock-seat.handler.ts`, `unlock-seat.handler.ts` |

---

## 2. Event Payload

```typescript
{
  seatIndex: number,
  isLocked: boolean   // true = locked, false = unlocked
}
```

---

## 3. Document Metadata

| Property | Value                                            |
| -------- | ------------------------------------------------ |
| Created  | 2026-02-09                                       |
| Sources  | `lock-seat.handler.ts`, `unlock-seat.handler.ts` |
