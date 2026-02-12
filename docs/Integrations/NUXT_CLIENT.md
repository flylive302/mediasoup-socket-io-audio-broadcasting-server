# Nuxt Frontend Integration Guide

> **Audience**: Frontend Team  
> **Last Updated**: 2026-02-12  
> **MSAB Version**: Current (`main` branch)

This is the **single reference** for integrating with the MSAB Audio Server from the Nuxt frontend.

---

## Table of Contents

1. [Connection Setup](#1-connection-setup)
2. [Authentication](#2-authentication)
3. [Event Patterns](#3-event-patterns)
4. [Complete Event Catalog](#4-complete-event-catalog)
5. [TypeScript Types](#5-typescript-types)
6. [Error Handling](#6-error-handling)
7. [State Sync Strategy](#7-state-sync-strategy)
8. [Debugging Tips](#8-debugging-tips)

---

## 1. Connection Setup

### Socket.IO Client Configuration

```typescript
import { io, Socket } from "socket.io-client";

const socket: Socket = io("wss://audio.flylive.app", {
  auth: {
    token: jwtToken, // JWT from Laravel
  },
  transports: ["websocket"], // WebSocket only, no polling fallback
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});
```

### Connection Lifecycle

```
Connect → Authenticate (JWT) → Join Room → Create Transport → Produce/Consume Audio
```

| Step | Event/Method        | Purpose                                    |
| ---- | ------------------- | ------------------------------------------ |
| 1    | `io()` connect      | Establish WebSocket + JWT auth             |
| 2    | `room:join`         | Join audio room, get RTP capabilities      |
| 3    | `transport:create`  | Create WebRTC producer/consumer transports |
| 4    | `transport:connect` | DTLS handshake                             |
| 5    | `audio:produce`     | Start sending audio                        |
| 6    | `audio:consume`     | Start receiving audio from others          |

---

## 2. Authentication

### JWT Structure

The JWT is issued by Laravel and contains user data. MSAB validates it with a shared HMAC-SHA256 secret.

```typescript
// JWT payload structure (embedded in token)
interface JwtPayload {
  id: number;
  name: string;
  signature: string;
  email: string;
  avatar: string;
  frame: string;
  gender: number; // integer (0=male, 1=female, etc.)
  date_of_birth: string; // ISO date (YYYY-MM-DD)
  phone: string;
  country: string;
  coins: string;
  diamonds: string;
  wealth_xp: string;
  charm_xp: string;
  is_blocked: boolean;
  isSpeaker: boolean;
  exp: number; // Expiration timestamp
}
```

> **Note**: `gender` is an integer matching the Laravel DB value.

### Connection Events

```typescript
socket.on("connect", () => {
  console.log("Connected to MSAB");
});

socket.on("connect_error", (err) => {
  // Common: "Invalid credentials" = JWT invalid/expired
  console.error("Connection failed:", err.message);
});

socket.on("disconnect", (reason) => {
  // "io server disconnect" = server kicked (blocked user, etc.)
  // "transport close" = network issue
  console.log("Disconnected:", reason);
});
```

---

## 3. Event Patterns

### Pattern 1: Emit with Acknowledgment (Request/Response)

Used for events that return data. The server calls back with a response.

```typescript
// Emit and wait for server response
const response = await socket.emitWithAck("room:join", {
  roomId: "42",
  ownerId: 1234,
  seatCount: 15, // Optional, defaults to 15
});

if (response.error) {
  throw new Error(response.error);
}

// Use response data
const { rtpCapabilities, participants, seats } = response;
```

**Events using this pattern**: `room:join`, `transport:create`, `transport:connect`, `audio:produce`, `audio:consume`, `consumer:resume`, `seat:take`, `seat:leave`, `seat:assign`, `seat:remove`, `seat:mute`, `seat:unmute`, `seat:lock`, `seat:unlock`, `seat:invite`, `seat:invite:accept`, `seat:invite:decline`, `chat:message`, `gift:send`, `gift:prepare`, `user:getRoom`

### Pattern 2: Fire-and-Forget

Used for events where the client does not wait for a callback. The server still processes via `createHandler` internally.

```typescript
// Emit without waiting for response
socket.emit("room:leave", { roomId: "42" });
```

**Events using this pattern**: `room:leave`

> **Note**: Most events now use `createHandler` internally and support ACK callbacks. Even `chat:message`, `gift:send`, and `seat:leave` return `{ success: boolean, error?: string }` via callback if one is provided.

### Pattern 3: Listen for Broadcasts

Used for receiving server-pushed events.

```typescript
// Listen for broadcasts from server
socket.on("room:userJoined", (payload) => {
  participants.value.push(payload);
});

socket.on("seat:updated", (payload) => {
  updateSeat(payload.seatIndex, payload.userId, payload.isMuted);
});

socket.on("gift:received", (payload) => {
  playGiftAnimation(payload.giftId);
});
```

**All S→C events**: `room:userJoined`, `room:userLeft`, `room:closed`, `audio:newProducer`, `speaker:active`, `seat:updated`, `seat:cleared`, `seat:locked`, `seat:userMuted`, `seat:invite:received`, `seat:invite:pending`, `chat:message`, `gift:received`, `gift:prepare`, `gift:error`

---

## 4. Complete Event Catalog

### C→S Events (Client sends to Server)

| Event                 | Domain | ACK | Purpose                       | Docs                                              |
| --------------------- | ------ | --- | ----------------------------- | ------------------------------------------------- |
| `room:join`           | Room   | ✅  | Join room, get state          | [📖](../Events/Room/join/README.md)               |
| `room:leave`          | Room   | ❌  | Leave room                    | [📖](../Events/Room/leave/README.md)              |
| `transport:create`    | Media  | ✅  | Create WebRTC transport       | [📖](../Events/Media/transport-create/README.md)  |
| `transport:connect`   | Media  | ✅  | DTLS handshake                | [📖](../Events/Media/transport-connect/README.md) |
| `audio:produce`       | Media  | ✅  | Start sending audio           | [📖](../Events/Media/audio-produce/README.md)     |
| `audio:consume`       | Media  | ✅  | Start receiving audio         | [📖](../Events/Media/audio-consume/README.md)     |
| `consumer:resume`     | Media  | ✅  | Resume paused consumer        | [📖](../Events/Media/consumer-resume/README.md)   |
| `seat:take`           | Seat   | ✅  | Request a seat                | [📖](../Events/Seat/take/README.md)               |
| `seat:leave`          | Seat   | ❌  | Leave seat                    | [📖](../Events/Seat/leave/README.md)              |
| `seat:assign`         | Seat   | ✅  | Assign user to seat (owner)   | [📖](../Events/Seat/assign/README.md)             |
| `seat:remove`         | Seat   | ✅  | Remove user from seat (owner) | [📖](../Events/Seat/remove/README.md)             |
| `seat:mute`           | Seat   | ✅  | Mute seated user (owner)      | [📖](../Events/Seat/mute/README.md)               |
| `seat:unmute`         | Seat   | ✅  | Unmute seated user            | [📖](../Events/Seat/unmute/README.md)             |
| `seat:lock`           | Seat   | ✅  | Lock seat (owner)             | [📖](../Events/Seat/lock/README.md)               |
| `seat:unlock`         | Seat   | ✅  | Unlock seat (owner)           | [📖](../Events/Seat/unlock/README.md)             |
| `seat:invite`         | Seat   | ✅  | Invite user to seat (owner)   | [📖](../Events/Seat/invite/README.md)             |
| `seat:invite:accept`  | Seat   | ✅  | Accept seat invitation        | [📖](../Events/Seat/invite-accept/README.md)      |
| `seat:invite:decline` | Seat   | ✅  | Decline seat invitation       | [📖](../Events/Seat/invite-decline/README.md)     |
| `chat:message`        | Chat   | ❌  | Send chat message             | [📖](../Events/Chat/message/README.md)            |
| `gift:send`           | Gift   | ❌  | Send virtual gift             | [📖](../Events/Gift/send/README.md)               |
| `gift:prepare`        | Gift   | ❌  | Preload gift signal           | [📖](../Events/Gift/prepare/README.md)            |
| `user:getRoom`        | User   | ✅  | Find user's current room      | [📖](../Events/User/get-room/README.md)           |

### S→C Events (Server broadcasts to Client)

| Event                  | Domain | Target              | Purpose                      | Docs                                                  |
| ---------------------- | ------ | ------------------- | ---------------------------- | ----------------------------------------------------- |
| `room:userJoined`      | Room   | Room (excl. sender) | User joined room             | [📖](../Events/Server/room-userJoined/README.md)      |
| `room:userLeft`        | Room   | Room (excl. sender) | User left room               | [📖](../Events/Server/room-userLeft/README.md)        |
| `room:closed`          | Room   | Room                | Room has been closed         | [📖](../Events/Server/room-closed/README.md)          |
| `audio:newProducer`    | Media  | Room (excl. sender) | New audio producer available | [📖](../Events/Server/audio-newProducer/README.md)    |
| `speaker:active`       | Media  | Room                | Active speaker changed       | [📖](../Events/Server/speaker-active/README.md)       |
| `seat:updated`         | Seat   | Room                | Seat taken (user details)    | [📖](../Events/Server/seat-updated/README.md)         |
| `seat:cleared`         | Seat   | Room                | Seat vacated                 | [📖](../Events/Server/seat-cleared/README.md)         |
| `seat:locked`          | Seat   | Room                | Seat locked/unlocked         | [📖](../Events/Server/seat-locked/README.md)          |
| `seat:userMuted`       | Seat   | Room                | User muted/unmuted           | [📖](../Events/Server/seat-userMuted/README.md)       |
| `seat:invite-received` | Seat   | Target user         | Invitation received          | [📖](../Events/Server/seat-invite-received/README.md) |
| `seat:invite-pending`  | Seat   | Room owner          | Invitation pending           | [📖](../Events/Server/seat-invite-pending/README.md)  |
| `chat:message`         | Chat   | Room (incl. sender) | Chat message (via `io.to()`) | [📖](../Events/Server/room-userJoined/README.md)      |
| `gift:received`        | Gift   | Room                | Gift animation trigger       | [📖](../Events/Server/gift-received/README.md)        |
| `gift:error`           | Gift   | Sender only         | Gift processing error        | [📖](../Events/Server/gift-error/README.md)           |

---

## 5. TypeScript Types

### User Object

The user object appears in many payloads (`room:join` response, `room:userJoined` broadcast, `seat:updated` broadcast).

```typescript
/** User data as received from MSAB in event payloads */
interface MsabUser {
  id: number;
  name: string;
  signature: string;
  avatar: string;
  frame: string;
  gender: number;
  country: string;
  phone: string;
  email: string;
  date_of_birth: string;
  wealth_xp: string; // String from JWT
  charm_xp: string; // String from JWT
  isSpeaker: boolean;
}
```

### Room Join Response

```typescript
/** Response from `room:join` acknowledgment */
interface RoomJoinResponse {
  rtpCapabilities: RtpCapabilities; // mediasoup types
  participants: MsabUser[];
  seats: SeatState[];
  lockedSeats: number[];
  existingProducers: { producerId: string; userId: number }[];
}
```

### Seat State

```typescript
/**
 * Seat state as received in `room:join` and `seat:updated`.
 * BL-007: Uses userId only — frontend resolves full user from participants list.
 */
interface SeatState {
  seatIndex: number;
  userId: number;
  isMuted: boolean;
}
```

### Chat Message

```typescript
/** Payload for `chat:message` broadcast (flat shape, not nested user object) */
interface ChatMessagePayload {
  id: string; // UUID
  userId: number;
  userName: string;
  avatar: string;
  content: string;
  type: "text" | "emoji" | "sticker" | "gift" | "system";
  timestamp: number;
}
```

### Gift Received

```typescript
/** Payload for `gift:received` broadcast */
interface GiftReceivedPayload {
  senderId: number;
  roomId: string;
  giftId: number;
  recipientId: number;
  quantity: number;
}
```

---

## 6. Error Handling

### Error Response Shape

All events that go through `createHandler` return a consistent shape:

```typescript
interface MsabResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

// Usage
const response = await socket.emitWithAck("event:name", payload);
if (!response.success) {
  handleError(response.error);
}
```

> **Note**: `room:join` is the only event that does NOT use `createHandler` — it returns either the full room state or `{ error: string }` directly.

### Common Errors (from `src/shared/errors.ts`)

| Error Message                    | Cause                       | Resolution                       |
| -------------------------------- | --------------------------- | -------------------------------- |
| `"Invalid credentials"`          | JWT expired or malformed    | Refresh JWT from Laravel         |
| `"Invalid payload"`              | Zod validation failed       | Check payload matches schema     |
| `"Internal server error"`        | Server exception            | Retry or report bug              |
| `"Not in room"`                  | Event sent for wrong room   | Verify room membership           |
| `"You are not seated"`           | Seat operation without seat | Check seat state first           |
| `"Seat is already taken"`        | Taking occupied seat        | Choose different seat            |
| `"Seat is locked"`               | Taking locked seat          | Choose different seat            |
| `"Too many requests"`            | Rate limited                | Wait before retrying             |
| `"Not authorized"`               | Missing owner permissions   | Only room owner can mutate seats |
| `"Cannot send gift to yourself"` | Self-gifting                | Select a different recipient     |
| `"Cannot invite yourself"`       | Self-invitation             | Select a different user          |

---

## 7. State Sync Strategy

### Initial State (on `room:join`)

When joining a room, the ACK response contains the complete room state:

```typescript
const state = await socket.emitWithAck("room:join", { roomId, ownerId });

// Populate all local state from this response
participants.value = state.participants;
seats.value = state.seats;
lockedSeats.value = state.lockedSeats;
producers.value = state.existingProducers;
rtpCapabilities.value = state.rtpCapabilities;
```

### Incremental Updates (via broadcasts)

After joining, keep state in sync via broadcasts:

| State        | Add/Update Event    | Remove Event           |
| ------------ | ------------------- | ---------------------- |
| Participants | `room:userJoined`   | `room:userLeft`        |
| Seats        | `seat:updated`      | `seat:cleared`         |
| Locked Seats | `seat:locked`       | `seat:locked` (toggle) |
| Producers    | `audio:newProducer` | `room:userLeft`        |
| Chat         | `chat:message`      | (append only)          |

### Room Lifecycle

```
room:join → [interact] → room:leave
                ↓             ↓
          room:closed    disconnect
```

- Always listen for `room:closed` to handle server-side room closure
- On `disconnect`, clean up mediasoup transports and rejoin on reconnect

---

## 8. Debugging Tips

### Enable Socket.IO Debug Logs

```typescript
// In browser console
localStorage.setItem("debug", "socket.io-client:*");
```

### Event Tracing Checklist

1. **Connection issues**: Check JWT expiration, verify JWT payload matches `UserSchema`
2. **Missing broadcasts**: Verify `socket.join(roomId)` succeeded (check `room:join` ACK)
3. **Audio issues**: Ensure `transport:create` → `transport:connect` → `audio:produce/consume` sequence
4. **Seat errors**: Only room owner (`ownerId`) can assign/remove/mute/lock seats

### Useful Server Events for Debugging

| Event               | What It Tells You                                        |
| ------------------- | -------------------------------------------------------- |
| `room:userJoined`   | Your join was successful (others receive this)           |
| `audio:newProducer` | Audio is being produced (consume this producer)          |
| `gift:error`        | Gift failed on Laravel side (insufficient balance, etc.) |

---

## Document Metadata

| Property         | Value         |
| ---------------- | ------------- |
| **Created**      | 2026-02-12    |
| **Last Updated** | 2026-02-12    |
| **Audience**     | Frontend Team |
| **Source**       | MSAB Codebase |

---

_Part of the [MSAB Documentation Standard](../DOCUMENTATION_STANDARD.md)_
