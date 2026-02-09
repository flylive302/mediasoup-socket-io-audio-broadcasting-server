# Event: `audio:newProducer`

> **Domain**: Media  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `audio:produce`

---

## 1. Event Overview

### Purpose

Notifies room members when a new audio producer is created (user started speaking).

### Key Characteristics

| Property     | Value                                 |
| ------------ | ------------------------------------- |
| Target       | All sockets in room (except producer) |
| Emitted From | `media.handler.ts:130`                |

---

## 2. Event Payload

```typescript
{
  producerId: string,   // UUID
  producerUserId: number
}
```

---

## 3. Usage

Clients use this event to initiate `audio:consume` for the new producer.

---

## 4. Document Metadata

| Property | Value                                    |
| -------- | ---------------------------------------- |
| Created  | 2026-02-09                               |
| Source   | `src/domains/media/media.handler.ts:130` |
