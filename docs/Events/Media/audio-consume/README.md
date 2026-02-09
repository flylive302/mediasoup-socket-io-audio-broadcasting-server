# Event: `audio:consume`

> **Domain**: Media  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `audio:produce`, `audio:newProducer`, `consumer:resume`

---

## 1. Event Overview

### Purpose

Creates a consumer to receive audio from a specific producer, enabling a client to listen to another user's audio stream.

### Business Context

When a speaker produces audio via `audio:produce`, listeners need to consume that audio. This event creates a mediasoup consumer that receives the RTP stream and returns the parameters needed for the client to play the audio.

### Key Characteristics

| Property                | Value                             |
| ----------------------- | --------------------------------- |
| Requires Authentication | Yes (via middleware)              |
| Has Acknowledgment      | Yes                               |
| Broadcasts              | No                                |
| Modifies State          | Creates Consumer in RouterManager |
| Prerequisite            | Connected consumer transport      |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `audioConsumeSchema`  
**Source**: `src/socket/schemas.ts:147-152`

```typescript
{
  roomId: string,           // Room ID (1-255 chars)
  transportId: string,      // UUID of consumer transport
  producerId: string,       // UUID of producer to consume
  rtpCapabilities: {        // Client's RTP capabilities
    codecs: RtpCodecCapability[],
    headerExtensions?: RtpHeaderExtension[]
  }
}
```

### 2.2 Acknowledgment (Success)

```typescript
{
  id: string,               // Consumer UUID
  producerId: string,       // Producer being consumed
  kind: "audio",            // Media kind
  rtpParameters: {          // For client to receive media
    codecs: RtpCodecParameters[],
    headerExtensions?: RtpHeaderExtension[],
    encodings?: RtpEncodingParameters[],
    rtcp?: RtcpParameters
  }
}
```

### 2.3 Acknowledgment (Error)

```typescript
{
  error: "Invalid payload" |
    "Room not found" |
    "Transport not found" |
    "Cannot consume" |
    "Consume failed";
}
```

---

## 3. Event Execution Flow

### 3.1 Entry Point

```
File: src/domains/media/media.handler.ts:156
```

```typescript
socket.on("audio:consume", async (rawPayload: unknown, callback) => {
  // Handler logic
});
```

### 3.2 Schema Validation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SCHEMA VALIDATION                                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:157-162                            │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const payloadResult = audioConsumeSchema.safeParse(rawPayload);         │ │
│ │ if (!payloadResult.success) {                                           │ │
│ │   if (callback) callback({ error: "Invalid payload" });                 │ │
│ │   return;                                                               │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Room & Transport Lookup

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ VALIDATE ROOM AND TRANSPORT                                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:166-175                            │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const routerMgr = await roomManager.getRoom(roomId);                    │ │
│ │ if (!routerMgr || !routerMgr.router) {                                  │ │
│ │   if (callback) callback({ error: "Room not found" });                  │ │
│ │   return;                                                               │ │
│ │ }                                                                       │ │
│ │                                                                         │ │
│ │ const transport = routerMgr.getTransport(transportId);                  │ │
│ │ if (!transport) {                                                       │ │
│ │   if (callback) callback({ error: "Transport not found" });             │ │
│ │   return;                                                               │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.4 Capability Check

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ CAN CONSUME CHECK                                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:177-181                            │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ if (!routerMgr.router.canConsume({                                      │ │
│ │   producerId,                                                           │ │
│ │   rtpCapabilities                                                       │ │
│ │ })) {                                                                   │ │
│ │   if (callback) callback({ error: "Cannot consume" });                  │ │
│ │   return;                                                               │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.5 Consumer Creation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ CREATE CONSUMER (PAUSED)                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:184-189                            │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const consumer = await transport.consume({                              │ │
│ │   producerId,                                                           │ │
│ │   rtpCapabilities,                                                      │ │
│ │   paused: true, // Start paused (recommended)                           │ │
│ │ });                                                                     │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.6 Event Handlers & Registration

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SETUP CLEANUP & REGISTER                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:191-197                            │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ consumer.on("transportclose", () => consumer.close());                  │ │
│ │ consumer.on("producerclose", () => consumer.close());                   │ │
│ │                                                                         │ │
│ │ if (routerMgr) {                                                        │ │
│ │   routerMgr.registerConsumer(consumer);                                 │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. State Transitions

### RouterManager State

| Property      | Before   | After               |
| ------------- | -------- | ------------------- |
| consumers map | No entry | Consumer registered |

### Consumer State

| Property | Value            |
| -------- | ---------------- |
| paused   | true (initially) |
| kind     | "audio"          |

---

## 5. Reusability Matrix

| Component             | Used For                     |
| --------------------- | ---------------------------- |
| `audioConsumeSchema`  | Validates consume request    |
| `router.canConsume()` | Checks codec compatibility   |
| `transport.consume()` | Creates mediasoup consumer   |
| `registerConsumer()`  | Tracks for `consumer:resume` |

---

## 6. Error Handling

| Error                 | Cause                           | Response     |
| --------------------- | ------------------------------- | ------------ |
| `Invalid payload`     | Schema validation fails         | Return error |
| `Room not found`      | Room doesn't exist or no router | Return error |
| `Transport not found` | Transport ID invalid            | Return error |
| `Cannot consume`      | Codec incompatibility           | Return error |
| `Consume failed`      | Internal mediasoup error        | Return error |

---

## 7. Sequence Diagram

```
Client                    MSAB                      Mediasoup
   │                        │                           │
   │                        │◀──audio:newProducer──────│
   │◀──audio:newProducer────│   (from other client)    │
   │   {producerId, userId} │                           │
   │                        │                           │
   │──audio:consume────────▶│                           │
   │   {transportId,        │                           │
   │    producerId,         │                           │
   │    rtpCapabilities}    │                           │
   │                        │                           │
   │                        │──router.canConsume()─────▶│
   │                        │◀─────────true─────────────│
   │                        │                           │
   │                        │──transport.consume()─────▶│
   │                        │◀──consumer (paused)───────│
   │                        │                           │
   │◀──{id, rtpParameters}──│                           │
   │                        │                           │
   │──consumer:resume──────▶│                           │
   │   (to start playback)  │                           │
```

---

## 8. Cross-Platform Integration

### Frontend Flow

```javascript
// 1. Listen for new producers
socket.on("audio:newProducer", async ({ producerId, userId }) => {
  // 2. Create consumer for this producer
  const { id, rtpParameters } = await socket.emitWithAck("audio:consume", {
    roomId,
    transportId: recvTransport.id,
    producerId,
    rtpCapabilities: device.rtpCapabilities,
  });

  // 3. Add track to transport
  const consumer = await recvTransport.consume({
    id,
    producerId,
    kind: "audio",
    rtpParameters,
  });

  // 4. Resume to start receiving
  await socket.emitWithAck("consumer:resume", { roomId, consumerId: id });

  // 5. Play audio
  const audioElement = new Audio();
  audioElement.srcObject = new MediaStream([consumer.track]);
  audioElement.play();
});
```

---

## 9. Extension & Maintenance Notes

- Consumer starts **paused** by design - client must call `consumer:resume`
- `producerclose` event auto-closes consumer when speaker stops
- Consumer ID needed for `consumer:resume` - client must store it

---

## 10. Document Metadata

| Property | Value                                |
| -------- | ------------------------------------ |
| Created  | 2026-02-09                           |
| Handler  | `src/domains/media/media.handler.ts` |
| Lines    | 156-208                              |
| Schema   | `src/socket/schemas.ts:147-152`      |
