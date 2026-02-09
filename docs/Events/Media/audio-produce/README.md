# `audio:produce` Event

> **Domain**: Media  
> **Direction**: C→S  
> **Handler**: `src/domains/media/media.handler.ts:89-155`

---

## 1. Event Overview

### Event: `audio:produce` (C→S)

### Purpose

Starts producing (sending) audio through a connected producer transport. This event creates a mediasoup Producer and broadcasts `audio:newProducer` to other room members.

### Domain

**Media** - WebRTC transport and audio streaming management

### Responsibilities

- Validate payload with Zod schema
- Verify transport exists
- Create mediasoup Producer from RTP parameters
- Track producer in ClientManager
- Add producer to active speaker observer
- Broadcast `audio:newProducer` to room
- Register producer in RouterManager
- Set up transport close cleanup

### What It Owns

| Owned                   | Description               |
| ----------------------- | ------------------------- |
| mediasoup Producer      | Audio producer instance   |
| Client speaker status   | `client.isSpeaker = true` |
| Active speaker tracking | Added to audioObserver    |

### External Dependencies

| Dependency      | Type    | Purpose                            |
| --------------- | ------- | ---------------------------------- |
| `RoomManager`   | Service | Get RouterManager                  |
| `RouterManager` | Service | Get transport, register producer   |
| `ClientManager` | Service | Track producer, set speaker status |

---

## 2. Event Contract

### Inbound Event

```
Event: audio:produce
Direction: C→S
Acknowledgment: ✅ Required (callback)
```

### Zod Schema

```typescript
// src/socket/schemas.ts:140-145
export const audioProduceSchema = z.object({
  roomId: roomIdSchema,
  transportId: z.string().uuid(),
  kind: z.enum(["audio"]),
  rtpParameters: rtpParametersSchema,
});
```

### Payload Schema

```json
{
  "roomId": "string",
  "transportId": "uuid",
  "kind": "audio",
  "rtpParameters": {
    "mid": "0",
    "codecs": [
      {
        "mimeType": "audio/opus",
        "payloadType": 111,
        "clockRate": 48000,
        "channels": 2
      }
    ],
    "headerExtensions": [...],
    "encodings": [{ "ssrc": 12345678 }]
  }
}
```

### Field Details

| Field           | Type     | Required | Constraints      | Example     |
| --------------- | -------- | -------- | ---------------- | ----------- |
| `roomId`        | `string` | ✅       | min 1 char       | `"42"`      |
| `transportId`   | `string` | ✅       | UUID format      | `"uuid-v4"` |
| `kind`          | `enum`   | ✅       | Only `"audio"`   | `"audio"`   |
| `rtpParameters` | `object` | ✅       | mediasoup format | See schema  |

### Acknowledgment Response

```json
// Success
{
  "id": "uuid"  // Producer ID
}

// Error
{
  "error": "Invalid payload" | "Transport not found" | "Produce failed"
}
```

### Emitted Events

| Event               | Target                  | When                   |
| ------------------- | ----------------------- | ---------------------- |
| `audio:newProducer` | Room (excluding sender) | After producer created |

---

## 3. Event Execution Flow

### 3.1 Entry Point

```
File: src/domains/media/media.handler.ts:90
```

```typescript
socket.on("audio:produce", async (rawPayload: unknown, callback) => {
  // Handler logic
});
```

### 3.2 Schema Validation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SCHEMA VALIDATION                                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:91-96                              │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const payloadResult = audioProduceSchema.safeParse(rawPayload);         │ │
│ │ if (!payloadResult.success) {                                           │ │
│ │   if (callback) callback({ error: "Invalid payload" });                 │ │
│ │   return;                                                               │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Transport Lookup

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ GET TRANSPORT                                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:98-104                             │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const routerMgr = await roomManager.getRoom(roomId);                    │ │
│ │ const transport = routerMgr?.getTransport(transportId);                 │ │
│ │                                                                         │ │
│ │ if (!transport) {                                                       │ │
│ │   if (callback) callback({ error: "Transport not found" });             │ │
│ │   return;                                                               │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.4 Producer Creation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ CREATE MEDIASOUP PRODUCER                                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:107-111                            │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const producer = await transport.produce({                              │ │
│ │   kind,                                                                 │ │
│ │   rtpParameters: rtpParameters as mediasoup.types.RtpParameters,        │ │
│ │   appData: { userId: socket.data.user.id },                             │ │
│ │ });                                                                     │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.5 Client Tracking

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ TRACK PRODUCER ON CLIENT                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:113-122                            │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const client = clientManager.getClient(socket.id);                      │ │
│ │ if (client) {                                                           │ │
│ │   client.producers.set(kind, producer.id);                              │ │
│ │   client.isSpeaker = true;                                              │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.6 Active Speaker Tracking

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ADD TO AUDIO OBSERVER                                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:124-127                            │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ if (routerMgr?.audioObserver) {                                         │ │
│ │   await routerMgr.audioObserver.addProducer({ producerId: producer.id });│
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.7 Broadcast to Room

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ NOTIFY ROOM OF NEW PRODUCER                                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:129-134                            │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ socket.to(roomId).emit("audio:newProducer", {                           │ │
│ │   producerId: producer.id,                                              │ │
│ │   userId: socket.data.user.id,                                          │ │
│ │   kind: "audio",                                                        │ │
│ │ });                                                                     │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.8 Register & Cleanup

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ REGISTER PRODUCER & TRANSPORT CLOSE HANDLER                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:136-148                            │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ if (routerMgr) {                                                        │ │
│ │   routerMgr.registerProducer(producer);                                 │ │
│ │ }                                                                       │ │
│ │                                                                         │ │
│ │ producer.on("transportclose", () => {                                   │ │
│ │   if (client) {                                                         │ │
│ │     client.producers.delete(kind);                                      │ │
│ │     client.isSpeaker = client.producers.size > 0;                       │ │
│ │   }                                                                     │ │
│ │   producer.close();                                                     │ │
│ │ });                                                                     │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. State Transitions

### ClientManager (In-Memory)

| Property           | Before  | After                        |
| ------------------ | ------- | ---------------------------- |
| `client.producers` | `Map()` | `Map({ audio: producerId })` |
| `client.isSpeaker` | `false` | `true`                       |

### RouterManager (In-Memory)

| Property                  | Before  | After                             |
| ------------------------- | ------- | --------------------------------- |
| `producers`               | `Map()` | `Map({ [producerId]: Producer })` |
| `audioObserver.producers` | +1      | Added for speaker detection       |

---

## 5. Reusability Matrix

| Component                          | File                | Used By         | Reusable | Reasoning |
| ---------------------------------- | ------------------- | --------------- | -------- | --------- |
| `audioProduceSchema`               | `socket/schemas.ts` | `audio:produce` | ✅       | Reusable  |
| `rtpParametersSchema`              | `socket/schemas.ts` | Multiple        | ✅       | Shared    |
| `RouterManager.registerProducer()` | `routerManager.ts`  | `audio:produce` | ✅       | Core      |

---

## 6. Error Handling & Edge Cases

### Errors

| Error                 | Condition           | Response    |
| --------------------- | ------------------- | ----------- |
| `Invalid payload`     | Zod fails           | `{ error }` |
| `Transport not found` | Transport missing   | `{ error }` |
| `Produce failed`      | mediasoup exception | `{ error }` |

### Edge Cases

| Scenario                | Behavior                              |
| ----------------------- | ------------------------------------- |
| Transport not connected | Produce fails                         |
| Already producing       | New producer replaces old in tracking |
| Multiple audio kinds    | Not supported (only `audio`)          |

---

## 7. Sequence Diagram (Textual)

```
 CLIENT          SOCKET.IO          HANDLER          ROUTER_MGR     AUDIO_OBSERVER
   │                  │                  │                │                │
   │  audio:produce   │                  │                │                │
   │  {roomId, transportId, rtpParams}   │                │                │
   │─────────────────▶│                  │                │                │
   │                  │ 1. dispatch      │                │                │
   │                  │─────────────────▶│                │                │
   │                  │                  │ 2. getTransport│                │
   │                  │                  │───────────────▶│                │
   │                  │                  │◀───────────────│                │
   │                  │                  │                │                │
   │                  │                  │ 3. transport.produce()          │
   │                  │                  │───────────────▶│                │
   │                  │                  │◀───────────────│ producer       │
   │                  │                  │                │                │
   │                  │                  │ 4. addProducer │                │
   │                  │                  │────────────────────────────────▶│
   │                  │                  │                │                │
   │                  │ 5. audio:newProducer (to room)    │                │
   │                  │                  │                │                │
   │                  │ 6. callback({id})│                │                │
   │◀─────────────────│                  │                │                │
   │                  │                  │                │                │
   │  RTP AUDIO ═════════════════════════════════════════════════════════▶│
```

---

## 8. Cross-Platform Integration

### Frontend Usage (Nuxt)

```typescript
// composables/useMediasoup.ts
const produce = async (roomId: string, track: MediaStreamTrack) => {
  const producer = await sendTransport.produce({
    track,
    codecOptions: { opusStereo: 1, opusDtx: 1 },
  });

  // Triggered by mediasoup-client's produce()
  sendTransport.on(
    "produce",
    async ({ kind, rtpParameters }, callback, errback) => {
      try {
        const response = await socket.emitWithAck("audio:produce", {
          roomId,
          transportId: sendTransport.id,
          kind,
          rtpParameters,
        });

        if (response.error) throw new Error(response.error);
        callback({ id: response.id });
      } catch (err) {
        errback(err);
      }
    },
  );

  return producer;
};
```

### Laravel Integration

_This event has no direct Laravel integration._

### Related Events

| Event               | Relationship                         |
| ------------------- | ------------------------------------ |
| `transport:create`  | Must create producer transport first |
| `transport:connect` | Must connect transport first         |
| `audio:newProducer` | Broadcast emitted to room            |
| `audio:consume`     | Other clients use this to receive    |
| `speaker:active`    | audioObserver may emit this          |

---

## 9. Extension & Maintenance Notes

### ✅ Where to Add New Features

| Feature Type         | Location                      |
| -------------------- | ----------------------------- |
| Video support        | Add `kind: "video"` to schema |
| Producer metadata    | Add to `appData` (L110)       |
| Custom codec options | In `transport.produce()` call |

### ⚠️ What Should NOT Be Modified Casually

| Item                        | Reason                         |
| --------------------------- | ------------------------------ |
| `audio:newProducer` payload | Clients depend on exact format |
| Producer ID return          | Clients need this for tracking |

### 📁 File Locations Quick Reference

| Purpose     | File                                        |
| ----------- | ------------------------------------------- |
| Handler     | `src/domains/media/media.handler.ts:89-155` |
| Schema      | `src/socket/schemas.ts:140-145`             |
| RTP Schemas | `src/socket/schemas.ts:32-123`              |

---

## 10. Document Metadata

| Property               | Value                |
| ---------------------- | -------------------- |
| **Event**              | `audio:produce`      |
| **Domain**             | Media                |
| **Direction**          | C→S                  |
| **Author**             | System Documentation |
| **Created**            | 2026-02-09           |
| **Last Updated**       | 2026-02-09           |
| **Node.js Version**    | ≥22.0.0              |
| **TypeScript Version** | ^5.7.0               |

---

_Documentation generated following [MSAB Documentation Standard](../../DOCUMENTATION_STANDARD.md)_
