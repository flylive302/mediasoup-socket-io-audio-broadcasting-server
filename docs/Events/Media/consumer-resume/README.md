# Event: `consumer:resume`

> **Domain**: Media  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `audio:consume` (prerequisite)

---

## 1. Event Overview

### Purpose

Resumes a paused consumer to start receiving media data from a producer.

### Business Context

Consumers are created in a paused state by `audio:consume` for flow control. Once the client has set up its local media track, it calls `consumer:resume` to begin receiving the audio stream.

### Key Characteristics

| Property                | Value                                |
| ----------------------- | ------------------------------------ |
| Requires Authentication | Yes (via middleware)                 |
| Has Acknowledgment      | Yes                                  |
| Broadcasts              | No                                   |
| Modifies State          | Consumer.paused = false              |
| Prerequisite            | `audio:consume` must be called first |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `consumerResumeSchema`  
**Source**: `src/socket/schemas.ts:200-203`

```typescript
{
  roomId: string,      // Room ID (1-255 chars)
  consumerId: string   // UUID of consumer from audio:consume
}
```

### 2.2 Acknowledgment (Success)

```typescript
{
  success: true;
}
```

### 2.3 Acknowledgment (Error)

```typescript
{
  error: "Invalid payload" |
    "Room not found" |
    "Consumer not found" |
    "Resume failed";
}
```

---

## 3. Event Execution Flow

### 3.1 Entry Point

```
File: src/domains/media/media.handler.ts:211
```

```typescript
socket.on("consumer:resume", async (rawPayload: unknown, callback) => {
  // Handler logic
});
```

### 3.2 Schema Validation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SCHEMA VALIDATION                                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:212-217                            │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const payloadResult = consumerResumeSchema.safeParse(rawPayload);       │ │
│ │ if (!payloadResult.success) {                                           │ │
│ │   if (callback) callback({ error: "Invalid payload" });                 │ │
│ │   return;                                                               │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Room & Consumer Lookup

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ FIND CONSUMER                                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:220-229                            │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const routerMgr = await roomManager.getRoom(roomId);                    │ │
│ │ if (!routerMgr) {                                                       │ │
│ │   if (callback) callback({ error: "Room not found" });                  │ │
│ │   return;                                                               │ │
│ │ }                                                                       │ │
│ │                                                                         │ │
│ │ const consumer = routerMgr.getConsumer(consumerId);                     │ │
│ │ if (!consumer) {                                                        │ │
│ │   if (callback) callback({ error: "Consumer not found" });              │ │
│ │   return;                                                               │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.4 Resume Consumer

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ RESUME MEDIA FLOW                                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:232-234                            │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ await consumer.resume();                                                │ │
│ │ if (callback) callback({ success: true });                              │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. State Transitions

### Consumer State

| Property | Before | After |
| -------- | ------ | ----- |
| paused   | true   | false |

After resume, RTP packets flow from producer → consumer.

---

## 5. Reusability Matrix

| Component                 | Used For                        |
| ------------------------- | ------------------------------- |
| `consumerResumeSchema`    | Validates room and consumer IDs |
| `routerMgr.getConsumer()` | Retrieves registered consumer   |
| `consumer.resume()`       | Starts RTP packet flow          |

---

## 6. Error Handling

| Error                | Cause                         | Response     |
| -------------------- | ----------------------------- | ------------ |
| `Invalid payload`    | Schema validation fails       | Return error |
| `Room not found`     | Room doesn't exist            | Return error |
| `Consumer not found` | Consumer ID invalid or closed | Return error |
| `Resume failed`      | Internal mediasoup error      | Return error |

---

## 7. Sequence Diagram

```
Client                    MSAB                      Mediasoup
   │                        │                           │
   │  (audio:consume done)  │                           │
   │  (local track ready)   │                           │
   │                        │                           │
   │──consumer:resume──────▶│                           │
   │   {roomId, consumerId} │                           │
   │                        │                           │
   │                        │──consumer.resume()───────▶│
   │                        │                           │
   │                        │◀──RTP packets start───────│
   │                        │                           │
   │◀──{success: true}──────│                           │
   │                        │                           │
   │◀─────────────────RTP audio data flows─────────────▶│
```

---

## 8. Cross-Platform Integration

### Frontend Usage

```javascript
// After audio:consume returns consumer parameters
const consumer = await recvTransport.consume({
  id: response.id,
  producerId: response.producerId,
  kind: "audio",
  rtpParameters: response.rtpParameters,
});

// Set up audio element
const audio = new Audio();
audio.srcObject = new MediaStream([consumer.track]);

// Resume on server to start receiving
await socket.emitWithAck("consumer:resume", {
  roomId,
  consumerId: consumer.id,
});

// Now play audio
audio.play();
```

### Why Start Paused?

- Gives client time to set up local playback
- Avoids packet loss during setup
- Follows mediasoup best practices

---

## 9. Extension & Maintenance Notes

- Consumer resume is **idempotent** - calling on already-resumed consumer is safe
- If producer pauses, consumer continues but receives no data
- Consider adding `consumer:pause` for mute-at-receiver functionality

---

## 10. Document Metadata

| Property | Value                                |
| -------- | ------------------------------------ |
| Created  | 2026-02-09                           |
| Handler  | `src/domains/media/media.handler.ts` |
| Lines    | 211-243                              |
| Schema   | `src/socket/schemas.ts:200-203`      |
