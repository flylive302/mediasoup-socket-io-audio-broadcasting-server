# Event: `seat:cleared`

> **Domain**: Seat  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `seat:leave`, `seat:remove`, `seat:lock`, disconnect

---

## 1. Event Overview

### Purpose

Notifies room when a seat becomes empty (user left, removed, or kicked by lock).

### Key Characteristics

| Property     | Value               |
| ------------ | ------------------- |
| Target       | All sockets in room |
| Emitted From | Multiple handlers   |

---

## 2. Event Payload

```typescript
{
  seatIndex: number; // 0-14
}
```

---

## 3. Document Metadata

| Property | Value                                                                     |
| -------- | ------------------------------------------------------------------------- |
| Created  | 2026-02-09                                                                |
| Sources  | `leave-seat.handler.ts`, `remove-seat.handler.ts`, `lock-seat.handler.ts` |
