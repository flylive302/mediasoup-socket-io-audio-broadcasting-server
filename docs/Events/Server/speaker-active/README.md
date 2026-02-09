# Event: `speaker:active`

> **Domain**: Media  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: Active speaker detection

---

## 1. Event Overview

### Purpose

Broadcasts the currently active speaker based on audio volume analysis.

### Key Characteristics

| Property     | Value                                |
| ------------ | ------------------------------------ |
| Target       | All sockets in room                  |
| Emitted From | `activeSpeaker.ts:24`                |
| Interval     | Periodic (based on volume detection) |

---

## 2. Event Payload

```typescript
{
  dominantSpeakerId: string | null; // Producer ID or null if silence
}
```

---

## 3. Document Metadata

| Property | Value                                   |
| -------- | --------------------------------------- |
| Created  | 2026-02-09                              |
| Source   | `src/domains/media/activeSpeaker.ts:24` |
