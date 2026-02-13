# Broadcast Event: `seat:userMuted`

> **Domain**: Seat / Media  
> **Direction**: Server → Clients (Broadcast)  
> **Transport**: Socket.IO  
> **Triggered By**: `seat:mute`, `seat:unmute`, `audio:selfMute`, `audio:selfUnmute`

---

## 1. Event Overview

### Purpose

Notifies room when a user's mute status changes (either by room manager or self).

### Key Characteristics

| Property     | Value                                                         |
| ------------ | ------------------------------------------------------------- |
| Target       | All sockets in room (including sender for manager mute)       |
| Emitted From | `mute-unmute.factory.ts` (manager), `media.handler.ts` (self) |
| Emitted Via  | `socket.nsp.to(roomId).emit()` or `socket.to(roomId).emit()`  |

---

## 2. Event Payload

### Manager Mute/Unmute (from `seat:mute` / `seat:unmute`)

```typescript
{
  userId: number,
  isMuted: boolean        // true = muted, false = unmuted
}
```

### Self Mute/Unmute (from `audio:selfMute` / `audio:selfUnmute`)

```typescript
{
  userId: number,
  isMuted: boolean,
  selfMuted: true          // Distinguishes self-mute from manager-mute
}
```

> [!NOTE]
> The `selfMuted` flag is only present when the user mutes/unmutes themselves. Frontend uses this to differentiate UI behavior (e.g. showing "muted by host" vs "muted").

---

## 3. Document Metadata

| Property         | Value                                        |
| ---------------- | -------------------------------------------- |
| **Event**        | `seat:userMuted`                             |
| **Created**      | 2026-02-09                                   |
| **Last Updated** | 2026-02-12                                   |
| **Sources**      | `mute-unmute.factory.ts`, `media.handler.ts` |

### Schema Change Log

| Date       | Change                                                            |
| ---------- | ----------------------------------------------------------------- |
| 2026-02-12 | Added `selfMuted` flag for `audio:selfMute`/`selfUnmute` triggers |
| 2026-02-12 | Added `audio:selfMute`/`audio:selfUnmute` as triggers             |

---

_Documentation generated following [MSAB Broadcast Template](../../../BROADCAST_TEMPLATE.md)_
