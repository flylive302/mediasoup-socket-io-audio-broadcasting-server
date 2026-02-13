# Broadcast Event: `speaker:active`

> **Domain**: Media  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: Active speaker detection (mediasoup `ActiveSpeakerObserver`)

---

## 1. Event Overview

### Purpose

Broadcasts the currently active speakers based on audio volume analysis. Uses a sliding-window top-N algorithm to track the most recent active speakers.

### Key Characteristics

| Property     | Value                                                |
| ------------ | ---------------------------------------------------- |
| Target       | All sockets in room                                  |
| Emitted From | `activeSpeaker.ts` (`ActiveSpeakerDetector.start()`) |
| Emitted Via  | `this.io.to(this.roomId).emit()`                     |
| Emission     | Only when active speaker set changes (PERF-003)      |

---

## 2. Event Payload

```typescript
{
  userId: string,                // Current dominant speaker's userId
  activeSpeakers: string[],      // Array of top-N active speaker userIds
  timestamp: number              // Date.now()
}
```

> [!NOTE]
> PERF-003: This event only fires when the active speaker set actually changes, not on every `dominantspeaker` callback. This dramatically reduces frontend re-renders.

---

## 3. Document Metadata

| Property         | Value                                |
| ---------------- | ------------------------------------ |
| **Event**        | `speaker:active`                     |
| **Created**      | 2026-02-09                           |
| **Last Updated** | 2026-02-12                           |
| **Source**       | `src/domains/media/activeSpeaker.ts` |

### Schema Change Log

| Date       | Change                                                                                 |
| ---------- | -------------------------------------------------------------------------------------- |
| 2026-02-12 | Payload rewritten: `{ dominantSpeakerId }` → `{ userId, activeSpeakers[], timestamp }` |
| 2026-02-12 | Added PERF-003 deduplication (only emits on set change)                                |

---

_Documentation generated following [MSAB Broadcast Template](../../../BROADCAST_TEMPLATE.md)_
