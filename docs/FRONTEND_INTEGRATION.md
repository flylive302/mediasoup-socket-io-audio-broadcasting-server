# Frontend Integration Guide

> **Complete reference for integrating the FlyLive Audio Server with your frontend application.**
>
> This document covers all Socket.IO events, payloads, responses, error handling, and best practices.

---

## Table of Contents

1. [Connection Setup](#1-connection-setup)
2. [Authentication](#2-authentication)
3. [Room Events](#3-room-events)
4. [Audio/Media Events (Mediasoup)](#4-audiomedia-events-mediasoup)
5. [Chat Events](#5-chat-events)
6. [Gift Events](#6-gift-events)
7. [Active Speaker Events](#7-active-speaker-events)
8. [Error Handling](#8-error-handling)
9. [Complete TypeScript Types](#9-complete-typescript-types)
10. [Full Implementation Example](#10-full-implementation-example)

---

## 1. Connection Setup

### Basic Connection

```typescript
import { io, Socket } from "socket.io-client";

const AUDIO_SERVER_URL = "https://audio.flylive.app"; // Production URL

const socket: Socket = io(AUDIO_SERVER_URL, {
  auth: {
    token: "your_sanctum_bearer_token", // Laravel Sanctum token
  },
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 10000,
  transports: ["websocket", "polling"], // WebSocket preferred
});
```

### Connection Events

```typescript
// Successful connection
socket.on("connect", () => {
  console.log("Connected to audio server:", socket.id);
});

// Connection error (including auth failure)
socket.on("connect_error", (error: Error) => {
  console.error("Connection failed:", error.message);
  // Possible errors:
  // - "Authentication required" (no token provided)
  // - "Invalid credentials" (token validation failed)
  // - "Authentication failed" (Laravel API error)
});

// Disconnection
socket.on("disconnect", (reason: string) => {
  console.log("Disconnected:", reason);
  // reasons: 'io server disconnect', 'io client disconnect',
  //          'ping timeout', 'transport close', 'transport error'
});

// Reconnection attempts
socket.on("reconnect_attempt", (attemptNumber: number) => {
  console.log("Reconnecting... attempt:", attemptNumber);
});

socket.on("reconnect", (attemptNumber: number) => {
  console.log("Reconnected after", attemptNumber, "attempts");
  // Re-join room if needed
});
```

---

## 2. Authentication

The audio server validates your **Laravel Sanctum Bearer Token** against the Laravel backend via an internal API.

### How It Works

1. Client connects with token in `auth.token`
2. Server validates token against Laravel's `/api/v1/internal/auth/validate`
3. Server caches valid tokens in Redis (5-minute TTL)
4. Server checks revocation list before cache

### Token Format

```typescript
// In socket auth
auth: {
  token: "your_sanctum_token"; // Without "Bearer " prefix
}

// OR via headers (fallback)
extraHeaders: {
  Authorization: "Bearer your_sanctum_token";
}
```

### User Data Structure (Available on Server)

After authentication, the server has access to:

```typescript
interface AuthenticatedUser {
  id: number; // User ID from Laravel
  name: string; // Display name
  email: string; // User email
  avatar_url?: string; // Profile picture URL
  role?: string; // User role (e.g., 'user', 'admin')
  [key: string]: unknown; // Additional fields from Laravel
}
```

---

## 3. Room Events

### `room:join` (Client → Server)

Join a room. This is the first step after connecting.

**Request Payload:**

```typescript
{
  roomId: string; // UUID of the room
}
```

**Response (via Acknowledgment Callback):**

```typescript
// Success
{
  rtpCapabilities: RTCRtpCapabilities; // Mediasoup RTP capabilities for WebRTC
}

// Error
{
  error: string; // 'Invalid payload' | 'Internal error'
}
```

**Example:**

```typescript
socket.emit("room:join", { roomId: "uuid-here" }, (response) => {
  if (response.error) {
    console.error("Failed to join room:", response.error);
    return;
  }

  // Store RTP capabilities for later use in consuming
  const rtpCapabilities = response.rtpCapabilities;
  console.log("Joined room, RTP capabilities received");
});
```

---

### `room:leave` (Client → Server)

Leave the current room.

**Request Payload:**

```typescript
{
  roomId: string; // UUID of the room
}
```

**Response:** None (fire and forget)

**Example:**

```typescript
socket.emit("room:leave", { roomId: "uuid-here" });
```

---

### `room:userJoined` (Server → Client)

Broadcast when another user joins the room.

**Payload:**

```typescript
{
  userId: number;        // ID of the user who joined
  user: {
    id: number;
    name: string;
    email: string;
    avatar_url?: string;
    role?: string;
  }
}
```

**Example:**

```typescript
socket.on("room:userJoined", (data) => {
  console.log(`${data.user.name} joined the room`);
  // Add user to participants list
  addParticipant(data.user);
});
```

---

### `room:userLeft` (Server → Client)

Broadcast when a user leaves the room (or disconnects).

**Payload:**

```typescript
{
  userId: number; // ID of the user who left
}
```

**Example:**

```typescript
socket.on("room:userLeft", (data) => {
  console.log(`User ${data.userId} left the room`);
  // Remove from participants list
  removeParticipant(data.userId);
  // Stop consuming their audio if applicable
});
```

---

### `room:closed` (Server → Client)

Broadcast when the entire room is closed.

**Payload:**

```typescript
{
  roomId: string; // The closed room's ID
  reason: string; // 'host_left' | 'banned' | 'admin_closed' | etc.
  timestamp: number; // Unix timestamp (ms)
}
```

**Example:**

```typescript
socket.on("room:closed", (data) => {
  console.log(`Room closed: ${data.reason}`);

  // Cleanup
  stopAllAudioProducers();
  stopAllAudioConsumers();

  // Navigate away
  router.push("/");
  toast.error("The room has ended");
});
```

---

## 4. Audio/Media Events (Mediasoup)

The audio server uses **Mediasoup** as an SFU (Selective Forwarding Unit). The flow is:

1. **Create Transport** → Get transport parameters
2. **Connect Transport** → Establish DTLS
3. **Produce** → Start sending audio
4. **Consume** → Start receiving audio from others
5. **Resume** → Unmute the consumer (consumers start paused)

---

### `transport:create` (Client → Server)

Create a WebRTC transport for sending or receiving audio.

**Request Payload:**

```typescript
{
  type: "producer" | "consumer"; // 'producer' for sending, 'consumer' for receiving
  roomId: string; // UUID of the room
}
```

**Response (via Acknowledgment Callback):**

```typescript
// Success
{
  id: string;                     // Transport ID (UUID)
  iceParameters: RTCIceParameters;
  iceCandidates: RTCIceCandidate[];
  dtlsParameters: RTCDtlsParameters;
}

// Error
{
  error: string;                  // 'Invalid payload' | 'Room not found' | 'Server error'
  details?: object;               // Zod validation errors (if payload invalid)
}
```

**Example:**

```typescript
// Create producer transport (for sending audio)
socket.emit("transport:create", { type: "producer", roomId }, (response) => {
  if (response.error) {
    console.error("Transport creation failed:", response.error);
    return;
  }

  const producerTransport = device.createSendTransport({
    id: response.id,
    iceParameters: response.iceParameters,
    iceCandidates: response.iceCandidates,
    dtlsParameters: response.dtlsParameters,
  });
});

// Create consumer transport (for receiving audio)
socket.emit("transport:create", { type: "consumer", roomId }, (response) => {
  if (response.error) return;

  const consumerTransport = device.createRecvTransport({
    id: response.id,
    iceParameters: response.iceParameters,
    iceCandidates: response.iceCandidates,
    dtlsParameters: response.dtlsParameters,
  });
});
```

---

### `transport:connect` (Client → Server)

Connect the transport by providing DTLS parameters.

**Request Payload:**

```typescript
{
  roomId: string;           // UUID of the room
  transportId: string;      // UUID of the transport
  dtlsParameters: {         // From mediasoup-client
    role?: 'auto' | 'client' | 'server';
    fingerprints: Array<{
      algorithm: string;
      value: string;
    }>;
  };
}
```

**Response (via Acknowledgment Callback):**

```typescript
// Success
{
  success: true;
}

// Error
{
  error: string;
} // 'Invalid payload' | 'Transport not found' | 'Connect failed'
```

**Example:**

```typescript
producerTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
  socket.emit(
    "transport:connect",
    { roomId, transportId: producerTransport.id, dtlsParameters },
    (response) => {
      if (response.error) {
        errback(new Error(response.error));
        return;
      }
      callback();
    }
  );
});
```

---

### `audio:produce` (Client → Server)

Start producing (sending) audio.

**Request Payload:**

```typescript
{
  roomId: string;           // UUID of the room
  transportId: string;      // UUID of the producer transport
  kind: 'audio';            // Only 'audio' is supported
  rtpParameters: {          // From mediasoup-client track.produce()
    codecs: Array<{
      mimeType: string;     // 'audio/opus'
      payloadType: number;
      clockRate: number;
      channels?: number;
      parameters?: object;
      rtcpFeedback?: object[];
    }>;
    headerExtensions: Array<{...}>;
    encodings: Array<{...}>;
    rtcp: {...};
  };
}
```

**Response (via Acknowledgment Callback):**

```typescript
// Success
{
  id: string; // Producer ID (UUID)
}

// Error
{
  error: string; // 'Invalid payload' | 'Transport not found' | 'Produce failed'
}
```

**Example:**

```typescript
producerTransport.on(
  "produce",
  async ({ kind, rtpParameters }, callback, errback) => {
    socket.emit(
      "audio:produce",
      { roomId, transportId: producerTransport.id, kind, rtpParameters },
      (response) => {
        if (response.error) {
          errback(new Error(response.error));
          return;
        }
        callback({ id: response.id });
      }
    );
  }
);

// Then produce the track
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const track = stream.getAudioTracks()[0];
const producer = await producerTransport.produce({ track });
```

---

### `audio:newProducer` (Server → Client)

Broadcast when someone starts producing audio. **You should consume this producer.**

**Payload:**

```typescript
{
  producerId: string; // UUID of the new producer
  userId: number; // ID of the user producing
  kind: "audio"; // Always 'audio'
}
```

**Example:**

```typescript
socket.on("audio:newProducer", async (data) => {
  console.log(`User ${data.userId} started speaking`);

  // Consume this producer
  await consumeAudio(data.producerId);
});
```

---

### `audio:consume` (Client → Server)

Start consuming (receiving) audio from a producer.

**Request Payload:**

```typescript
{
  roomId: string;              // UUID of the room
  transportId: string;         // UUID of the consumer transport
  producerId: string;          // UUID of the producer to consume
  rtpCapabilities: {           // From device.rtpCapabilities
    codecs: Array<{...}>;
    headerExtensions: Array<{...}>;
  };
}
```

**Response (via Acknowledgment Callback):**

```typescript
// Success
{
  id: string;              // Consumer ID (UUID)
  producerId: string;      // The producer being consumed
  kind: 'audio';
  rtpParameters: {...};    // RTP parameters for the consumer
}

// Error
{
  error: string  // 'Invalid payload' | 'Room not found' | 'Transport not found' | 'Cannot consume' | 'Consume failed'
}
```

**Example:**

```typescript
async function consumeAudio(producerId: string) {
  socket.emit(
    "audio:consume",
    {
      roomId,
      transportId: consumerTransport.id,
      producerId,
      rtpCapabilities: device.rtpCapabilities,
    },
    async (response) => {
      if (response.error) {
        console.error("Consume failed:", response.error);
        return;
      }

      const consumer = await consumerTransport.consume({
        id: response.id,
        producerId: response.producerId,
        kind: response.kind,
        rtpParameters: response.rtpParameters,
      });

      // **IMPORTANT: Resume the consumer to start receiving audio**
      socket.emit(
        "consumer:resume",
        { roomId, consumerId: consumer.id },
        (res) => {
          if (res.success) {
            // Attach to audio element
            const audio = new Audio();
            audio.srcObject = new MediaStream([consumer.track]);
            audio.play();
          }
        }
      );
    }
  );
}
```

---

### `consumer:resume` (Client → Server)

Resume a paused consumer. **Consumers start paused by default** - you MUST call this to hear audio.

**Request Payload:**

```typescript
{
  roomId: string; // UUID of the room
  consumerId: string; // UUID of the consumer
}
```

**Response (via Acknowledgment Callback):**

```typescript
// Success
{
  success: true;
}

// Error
{
  error: string;
} // 'Invalid payload' | 'Room not found' | 'Consumer not found' | 'Resume failed'
```

**Example:**

```typescript
socket.emit("consumer:resume", { roomId, consumerId }, (response) => {
  if (response.success) {
    console.log("Consumer resumed, audio should be playing");
  }
});
```

---

## 5. Chat Events

### `chat:message` (Client → Server)

Send a chat message to the room.

**Request Payload:**

```typescript
{
  roomId: string;     // UUID of the room
  content: string;    // Message content (1-500 characters)
  type?: string;      // Optional message type (e.g., 'text', 'emoji', 'system')
}
```

**Response:** None (but will broadcast `chat:message` back to all including sender)

**Rate Limit:** 60 messages per minute (configurable via `RATE_LIMIT_MESSAGES_PER_MINUTE`)

---

### `chat:message` (Server → Client)

Broadcast when a chat message is sent (including to the sender).

**Payload:**

```typescript
{
  id: string; // Unique message ID (UUID)
  userId: number; // Sender's user ID
  userName: string; // Sender's display name
  avatar: string; // Sender's avatar URL
  content: string; // Message content
  type: string; // 'text' | custom type
  timestamp: number; // Unix timestamp (ms)
}
```

**Example:**

```typescript
// Send message
function sendMessage(content: string) {
  socket.emit("chat:message", { roomId, content });
}

// Receive messages
socket.on("chat:message", (message) => {
  // Add to chat list
  chatMessages.push({
    id: message.id,
    user: {
      id: message.userId,
      name: message.userName,
      avatar: message.avatar,
    },
    content: message.content,
    timestamp: new Date(message.timestamp),
  });
});
```

---

## 6. Gift Events

### `gift:send` (Client → Server)

Send a gift to a user in the room.

**Request Payload:**

```typescript
{
  roomId: string;       // UUID of the room
  giftId: string;       // UUID of the gift type
  recipientId: number;  // User ID of the recipient
  quantity?: number;    // Number of gifts (default: 1, must be positive integer)
}
```

**Response:** None (fire and forget, but broadcasts `gift:received` immediately)

**Rate Limit:** 30 gifts per minute

**Important:** Gifts are processed **optimistically** - the `gift:received` event is sent immediately for smooth UI. The actual balance deduction happens asynchronously via batch processing to Laravel.

---

### `gift:received` (Server → Client)

Broadcast when a gift is sent (for showing animations to room participants).

**Payload:**

```typescript
{
  senderId: number; // User ID of the sender
  senderName: string; // Display name of sender
  senderAvatar: string; // Avatar URL of sender
  roomId: string; // Room where gift was sent
  giftId: string; // Gift type ID
  recipientId: number; // User ID of recipient
  quantity: number; // Number of gifts
}
```

**Example:**

```typescript
socket.on("gift:received", (gift) => {
  // Show gift animation
  showGiftAnimation({
    sender: {
      id: gift.senderId,
      name: gift.senderName,
      avatar: gift.senderAvatar,
    },
    recipient: { id: gift.recipientId },
    giftType: gift.giftId,
    count: gift.quantity,
  });

  // Play sound
  playGiftSound(gift.giftId);
});
```

---

### `gift:error` (Server → Client)

Sent **only to the sender** when a gift transaction fails (e.g., insufficient balance).

**Payload:**

```typescript
{
  transactionId: string; // Internal transaction ID
  error: string; // Error code: 'insufficient_balance' | 'invalid_gift' | etc.
}
```

**Example:**

```typescript
socket.on("gift:error", (error) => {
  if (error.error === "insufficient_balance") {
    toast.error("Not enough coins! Please top up.");
    // Optionally: refresh user's balance from API
  } else {
    toast.error("Gift failed. Please try again.");
  }
});
```

---

## 7. Active Speaker Events

### `speaker:active` (Server → Client)

Broadcast when the dominant speaker changes (who is currently talking the loudest).

**Payload:**

```typescript
{
  userId: string; // User ID of the active speaker
  volume: number; // Volume level (currently always 0, reserved for future use)
  timestamp: number; // Unix timestamp (ms)
}
```

**Example:**

```typescript
socket.on("speaker:active", (data) => {
  // Highlight the active speaker in UI
  setActiveSpeaker(data.userId);

  // Maybe enlarge their avatar/card
  highlightUser(data.userId);
});
```

---

## 8. Error Handling

### Generic Error Event

The server may emit an `error` event for various issues.

**Payload:**

```typescript
{
  message: string;       // Human-readable error message
  errors?: object;       // Zod validation error details (if applicable)
}
```

**Common Errors:**

| Message                            | Cause                              |
| ---------------------------------- | ---------------------------------- |
| `Invalid payload`                  | Request data failed Zod validation |
| `Too many messages`                | Chat rate limit exceeded           |
| `Too many gifts, please slow down` | Gift rate limit exceeded           |
| `Invalid gift payload`             | Gift request data invalid          |

**Example:**

```typescript
socket.on("error", (error) => {
  console.error("Socket error:", error.message);

  if (error.message === "Too many messages") {
    toast.warn("Slow down! You are sending too many messages.");
  } else if (error.errors) {
    console.error("Validation errors:", error.errors);
  }
});
```

### Handling Connection Errors

```typescript
socket.on("connect_error", (error) => {
  if (error.message === "Authentication required") {
    // No token provided
    redirectToLogin();
  } else if (error.message === "Invalid credentials") {
    // Token is invalid or expired
    refreshToken().then(() => socket.connect());
  } else if (error.message === "Authentication failed") {
    // Server error validating token
    toast.error("Connection failed. Please try again.");
  }
});
```

---

## 9. Complete TypeScript Types

```typescript
// ============================================
// REQUEST PAYLOADS (Client → Server)
// ============================================

interface JoinRoomPayload {
  roomId: string; // UUID
}

interface LeaveRoomPayload {
  roomId: string; // UUID
}

interface TransportCreatePayload {
  type: "producer" | "consumer";
  roomId: string; // UUID
}

interface TransportConnectPayload {
  roomId: string; // UUID
  transportId: string; // UUID
  dtlsParameters: DtlsParameters;
}

interface AudioProducePayload {
  roomId: string; // UUID
  transportId: string; // UUID
  kind: "audio";
  rtpParameters: RtpParameters;
}

interface AudioConsumePayload {
  roomId: string; // UUID
  transportId: string; // UUID
  producerId: string; // UUID
  rtpCapabilities: RtpCapabilities;
}

interface ConsumerResumePayload {
  roomId: string; // UUID
  consumerId: string; // UUID
}

interface ChatMessagePayload {
  roomId: string; // UUID
  content: string; // 1-500 chars
  type?: string;
}

interface SendGiftPayload {
  roomId: string; // UUID
  giftId: string; // UUID
  recipientId: number; // positive integer
  quantity?: number; // positive integer, default 1
}

// ============================================
// RESPONSE PAYLOADS (Server → Client)
// ============================================

interface JoinRoomResponse {
  rtpCapabilities?: RtpCapabilities;
  error?: string;
}

interface TransportCreateResponse {
  id?: string;
  iceParameters?: IceParameters;
  iceCandidates?: IceCandidate[];
  dtlsParameters?: DtlsParameters;
  error?: string;
  details?: object;
}

interface TransportConnectResponse {
  success?: boolean;
  error?: string;
}

interface AudioProduceResponse {
  id?: string;
  error?: string;
}

interface AudioConsumeResponse {
  id?: string;
  producerId?: string;
  kind?: "audio";
  rtpParameters?: RtpParameters;
  error?: string;
}

interface ConsumerResumeResponse {
  success?: boolean;
  error?: string;
}

// ============================================
// BROADCAST PAYLOADS (Server → All Clients)
// ============================================

interface UserJoinedEvent {
  userId: number;
  user: {
    id: number;
    name: string;
    email: string;
    avatar_url?: string;
    role?: string;
  };
}

interface UserLeftEvent {
  userId: number;
}

interface RoomClosedEvent {
  roomId: string;
  reason: string;
  timestamp: number;
}

interface NewProducerEvent {
  producerId: string;
  userId: number;
  kind: "audio";
}

interface ChatMessageEvent {
  id: string;
  userId: number;
  userName: string;
  avatar: string;
  content: string;
  type: string;
  timestamp: number;
}

interface GiftReceivedEvent {
  senderId: number;
  senderName: string;
  senderAvatar: string;
  roomId: string;
  giftId: string;
  recipientId: number;
  quantity: number;
}

interface GiftErrorEvent {
  transactionId: string;
  error: string;
}

interface ActiveSpeakerEvent {
  userId: string;
  volume: number;
  timestamp: number;
}

interface ErrorEvent {
  message: string;
  errors?: object;
}
```

---

## 10. Full Implementation Example

### Complete Room Store (Pinia)

```typescript
import { defineStore } from "pinia";
import { io, Socket } from "socket.io-client";
import { Device } from "mediasoup-client";
import type { Transport, Producer, Consumer } from "mediasoup-client/lib/types";

interface RoomState {
  socket: Socket | null;
  device: Device | null;
  roomId: string | null;
  connected: boolean;
  participants: Map<number, User>;
  producerTransport: Transport | null;
  consumerTransport: Transport | null;
  producer: Producer | null;
  consumers: Map<string, Consumer>;
  activeSpeakerId: number | null;
  messages: ChatMessage[];
}

export const useRoomStore = defineStore("room", {
  state: (): RoomState => ({
    socket: null,
    device: null,
    roomId: null,
    connected: false,
    participants: new Map(),
    producerTransport: null,
    consumerTransport: null,
    producer: null,
    consumers: new Map(),
    activeSpeakerId: null,
    messages: [],
  }),

  actions: {
    // Initialize connection
    async connect(token: string) {
      this.socket = io("https://audio.flylive.app", {
        auth: { token },
        reconnection: true,
      });

      this.device = new Device();

      // Setup all event listeners
      this._setupSocketListeners();
    },

    // Join a room
    async joinRoom(roomId: string) {
      return new Promise((resolve, reject) => {
        this.socket!.emit("room:join", { roomId }, async (response) => {
          if (response.error) {
            reject(new Error(response.error));
            return;
          }

          this.roomId = roomId;
          this.connected = true;

          // Load device with RTP capabilities
          await this.device!.load({
            routerRtpCapabilities: response.rtpCapabilities,
          });

          // Create transports
          await this._createTransports();

          resolve(true);
        });
      });
    },

    // Leave room
    async leaveRoom() {
      if (this.roomId) {
        this.socket!.emit("room:leave", { roomId: this.roomId });
      }

      // Cleanup
      this.producer?.close();
      this.consumers.forEach((c) => c.close());
      this.producerTransport?.close();
      this.consumerTransport?.close();

      this.$reset();
    },

    // Start producing audio
    async startAudio() {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const track = stream.getAudioTracks()[0];
      this.producer = await this.producerTransport!.produce({ track });
    },

    // Stop producing audio
    async stopAudio() {
      this.producer?.close();
      this.producer = null;
    },

    // Send chat message
    sendMessage(content: string) {
      this.socket!.emit("chat:message", { roomId: this.roomId, content });
    },

    // Send gift
    sendGift(recipientId: number, giftId: string, quantity = 1) {
      this.socket!.emit("gift:send", {
        roomId: this.roomId,
        giftId,
        recipientId,
        quantity,
      });
    },

    // Private: Create transports
    async _createTransports() {
      // Producer transport
      await new Promise<void>((resolve) => {
        this.socket!.emit(
          "transport:create",
          { type: "producer", roomId: this.roomId },
          (response) => {
            this.producerTransport = this.device!.createSendTransport({
              id: response.id,
              iceParameters: response.iceParameters,
              iceCandidates: response.iceCandidates,
              dtlsParameters: response.dtlsParameters,
            });

            this.producerTransport.on(
              "connect",
              ({ dtlsParameters }, callback) => {
                this.socket!.emit(
                  "transport:connect",
                  {
                    roomId: this.roomId,
                    transportId: this.producerTransport!.id,
                    dtlsParameters,
                  },
                  () => callback()
                );
              }
            );

            this.producerTransport.on(
              "produce",
              ({ kind, rtpParameters }, callback) => {
                this.socket!.emit(
                  "audio:produce",
                  {
                    roomId: this.roomId,
                    transportId: this.producerTransport!.id,
                    kind,
                    rtpParameters,
                  },
                  (res) => callback({ id: res.id })
                );
              }
            );

            resolve();
          }
        );
      });

      // Consumer transport
      await new Promise<void>((resolve) => {
        this.socket!.emit(
          "transport:create",
          { type: "consumer", roomId: this.roomId },
          (response) => {
            this.consumerTransport = this.device!.createRecvTransport({
              id: response.id,
              iceParameters: response.iceParameters,
              iceCandidates: response.iceCandidates,
              dtlsParameters: response.dtlsParameters,
            });

            this.consumerTransport.on(
              "connect",
              ({ dtlsParameters }, callback) => {
                this.socket!.emit(
                  "transport:connect",
                  {
                    roomId: this.roomId,
                    transportId: this.consumerTransport!.id,
                    dtlsParameters,
                  },
                  () => callback()
                );
              }
            );

            resolve();
          }
        );
      });
    },

    // Private: Consume a producer
    async _consumeProducer(producerId: string) {
      return new Promise<void>((resolve) => {
        this.socket!.emit(
          "audio:consume",
          {
            roomId: this.roomId,
            transportId: this.consumerTransport!.id,
            producerId,
            rtpCapabilities: this.device!.rtpCapabilities,
          },
          async (response) => {
            if (response.error) {
              console.error("Consume failed:", response.error);
              resolve();
              return;
            }

            const consumer = await this.consumerTransport!.consume({
              id: response.id,
              producerId: response.producerId,
              kind: response.kind,
              rtpParameters: response.rtpParameters,
            });

            this.consumers.set(consumer.id, consumer);

            // Resume consumer
            this.socket!.emit(
              "consumer:resume",
              { roomId: this.roomId, consumerId: consumer.id },
              () => {
                // Attach to audio
                const audio = new Audio();
                audio.srcObject = new MediaStream([consumer.track]);
                audio.play();
                resolve();
              }
            );
          }
        );
      });
    },

    // Private: Setup socket listeners
    _setupSocketListeners() {
      // Room events
      this.socket!.on("room:userJoined", (data) => {
        this.participants.set(data.userId, data.user);
      });

      this.socket!.on("room:userLeft", (data) => {
        this.participants.delete(data.userId);
      });

      this.socket!.on("room:closed", (data) => {
        this.leaveRoom();
        // Navigate to home
      });

      // Audio events
      this.socket!.on("audio:newProducer", async (data) => {
        await this._consumeProducer(data.producerId);
      });

      // Chat events
      this.socket!.on("chat:message", (message) => {
        this.messages.push(message);
      });

      // Gift events
      this.socket!.on("gift:received", (gift) => {
        // Show animation
      });

      this.socket!.on("gift:error", (error) => {
        // Show error toast
      });

      // Active speaker
      this.socket!.on("speaker:active", (data) => {
        this.activeSpeakerId = parseInt(data.userId);
      });

      // Errors
      this.socket!.on("error", (error) => {
        console.error("Socket error:", error.message);
      });
    },
  },
});
```

---

## Quick Reference Card

| Event               | Direction | Purpose                              |
| ------------------- | --------- | ------------------------------------ |
| `room:join`         | C→S       | Join room, get RTP capabilities      |
| `room:leave`        | C→S       | Leave room                           |
| `room:userJoined`   | S→C       | User joined notification             |
| `room:userLeft`     | S→C       | User left notification               |
| `room:closed`       | S→C       | Room ended notification              |
| `transport:create`  | C→S       | Create WebRTC transport              |
| `transport:connect` | C→S       | Connect transport (DTLS)             |
| `audio:produce`     | C→S       | Start sending audio                  |
| `audio:newProducer` | S→C       | Someone started audio (consume them) |
| `audio:consume`     | C→S       | Start receiving audio                |
| `consumer:resume`   | C→S       | Unmute consumer                      |
| `chat:message`      | C→S / S→C | Send/receive chat                    |
| `gift:send`         | C→S       | Send gift                            |
| `gift:received`     | S→C       | Gift animation trigger               |
| `gift:error`        | S→C       | Gift failed (to sender only)         |
| `speaker:active`    | S→C       | Active speaker changed               |
| `error`             | S→C       | Generic error                        |

---

**Server URL:** `wss://audio.flylive.app` (Production) / `ws://localhost:3030` (Development)

**Required Ports:** UDP 10000-59999 (for WebRTC media)
