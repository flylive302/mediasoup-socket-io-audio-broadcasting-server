# Frontend Requirements: Region-Aware MSAB Connection

> **Context:** MSAB now runs in 3 AWS regions. When a room is live, the Laravel API returns `hosting_region` indicating which region is hosting it. The frontend must connect to the correct regional WebSocket endpoint so all users in the same room are on the same MSAB instance.

---

## Current Architecture (No Changes Needed Here)

The socket is a **singleton** managed by `useAudioSocket()` in `app/composables/room/useAudioSocket.ts`. The `socket.client.ts` plugin connects on auth and disconnects on logout. This singleton pattern stays the same.

The server URL currently comes from `config.public.audioServerUrl` (env: `NUXT_PUBLIC_AUDIO_SERVER_URL`).

---

## What Changes

### 1. Add Region Endpoint Map

Create a utility or add to an existing config:

```typescript
// app/constants/audio.ts (or similar)
export const REGION_ENDPOINTS: Record<string, string> = {
  "ap-south-1": "wss://mumbai.audio.flyliveapp.com",
  "me-south-1": "wss://uae.audio.flyliveapp.com",
  "eu-central-1": "wss://frankfurt.audio.flyliveapp.com",
};
```

---

### 2. Update `useAudioSocket.ts` — Add `reconnectToUrl()`

The existing `connect()` always uses `config.public.audioServerUrl`. Add a method to reconnect to a specific URL:

```typescript
// Inside useAudioSocket()

function reconnectToUrl(url: string) {
  // Skip if already connected to this URL
  if (socket.value?.io?.uri === url && socket.value?.connected) {
    return;
  }

  // Disconnect existing connection
  if (socket.value) {
    socket.value.removeAllListeners();
    socket.value.disconnect();
    resetRealtimeHandlers();
  }

  status.value = "connecting";
  error.value = null;

  // Connect to the new URL (same auth/options as connect())
  socket.value = io(url, {
    auth: { token: authStore.msabToken },
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000,
    transports: ["websocket", "polling"],
  });

  // Re-register all event handlers
  socket.value.on("connect", handleConnect);
  socket.value.on("disconnect", handleDisconnect);
  socket.value.on("connect_error", handleConnectError);
  socket.value.io.on("reconnect_attempt", handleReconnectAttempt);
  socket.value.io.on("reconnect", handleReconnect);
  socket.value.on("error", handleError);
}
```

Expose `reconnectToUrl` in the return object.

---

### 3. Update Room Join Flow

Wherever the user navigates to a room (likely in the room page or a composable that handles room entry):

```typescript
import { REGION_ENDPOINTS } from "~/constants/audio";

// Before emitting room:join...
const room = await laravelApi.getRoom(roomId);
const { reconnectToUrl } = useAudioSocket();

if (room.hosting_region && REGION_ENDPOINTS[room.hosting_region]) {
  // Room is live on a specific region — connect there
  await reconnectToUrl(REGION_ENDPOINTS[room.hosting_region]);
}
// else: room not live, current connection (nearest region) is fine

// Then proceed with room:join as usual
emitAsync("room:join", { roomId, seatCount, ownerId });
```

---

### 4. Room Leave — Reconnect to Default

When the user leaves a room, reconnect to the default (nearest) endpoint so global events have lowest latency:

```typescript
// After room:leave
const config = useRuntimeConfig();
reconnectToUrl(config.public.audioServerUrl);
```

---

### 5. Disconnect Recovery

If the socket disconnects unexpectedly while in a room:

1. Re-fetch room data from Laravel (`GET /api/v1/rooms/{id}`)
2. Check `hosting_region` — it may have changed if room closed and reopened
3. Reconnect to the correct endpoint
4. Re-join the room

---

## New Laravel API Field

Room detail and list responses now include:

```json
{
  "id": 42,
  "name": "My Room",
  "country": "IN",
  "is_live": true,
  "hosting_region": "ap-south-1",
  ...
}
```

`hosting_region` is `null` when the room is not currently live.

---

## Important Notes

- **Global events (agency, balance, badges) work on ANY region** — SNS delivers to all regions, so whichever MSAB the user is connected to will forward these events.
- **No dual-socket needed** — one connection handles everything (room audio + global events).
- **The reconnect only happens when entering/leaving a room**, not on every page navigation.

---

## Summary

| What                      | File                 | Effort       |
| ------------------------- | -------------------- | ------------ |
| Region endpoint map       | `constants/audio.ts` | ~5 min       |
| `reconnectToUrl()` method | `useAudioSocket.ts`  | ~30 min      |
| Room join flow update     | Room page/composable | ~30 min      |
| Room leave reconnect      | Room page/composable | ~15 min      |
| Disconnect recovery       | `useAudioSocket.ts`  | ~30 min      |
| **Total**                 |                      | **~2 hours** |
