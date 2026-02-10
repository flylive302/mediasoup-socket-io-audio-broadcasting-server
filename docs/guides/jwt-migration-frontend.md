# JWT Migration Guide — Frontend

## Overview

The audio server now authenticates WebSocket connections via **JWT** instead of the Sanctum opaque token. You need to send the JWT issued by Laravel when connecting to the audio server.

---

## What Changed

| Before                             | After                                   |
| ---------------------------------- | --------------------------------------- |
| Send Sanctum token in `auth.token` | Send JWT (from Laravel) in `auth.token` |

That's it. No other frontend changes required.

---

## Implementation

### 1. Get the JWT from Laravel

After login, Laravel will return an `audio_server_token` field alongside the existing Sanctum token:

```json
{
  "user": { ... },
  "token": "sanctum-token-for-api-calls",
  "audio_server_token": "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6NDIsIm5hbWUi..."
}
```

Store the `audio_server_token` — this is what you send to the audio server.

### 2. Connect to Audio Server

```typescript
import { io } from "socket.io-client";

const socket = io("https://audio.flyliveapp.com", {
  auth: {
    token: audioServerToken, // ← Use the JWT, not the Sanctum token
  },
});
```

### 3. Token Refresh

When the Sanctum token is refreshed, Laravel will also return a new `audio_server_token`. Update your stored value and use it for new connections.

---

## What You Can Remove

Nothing — the change is simply swapping which token value you pass in `auth.token`.

---

## Error Handling (Unchanged)

Auth errors remain the same:

| Error Message             | Meaning                          |
| ------------------------- | -------------------------------- |
| `Authentication required` | No token provided                |
| `Invalid credentials`     | JWT invalid, expired, or revoked |
| `Authentication failed`   | Unexpected server error          |
| `Origin not allowed`      | CORS origin blocked              |
