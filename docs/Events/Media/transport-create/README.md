# `transport:create` Event

> **Domain**: Media  
> **Direction**: C→S  
> **Handler**: `src/domains/media/media.handler.ts:17-59`

---

## 1. Event Overview

### Event: `transport:create` (C→S)

### Purpose

Creates a WebRTC transport for either sending (producer) or receiving (consumer) audio. This is the first step in establishing WebRTC media connections.

### Domain

**Media** - WebRTC transport and audio streaming management

### Responsibilities

- Validate payload via Zod schema
- Verify room exists
- Create WebRTC transport via mediasoup RouterManager
- Track transport in ClientManager for cleanup
- Return transport parameters for client DTLS handshake

### What It Owns

| Owned                     | Description                                |
| ------------------------- | ------------------------------------------ |
| WebRTC Transport          | mediasoup WebRtcTransport instance created |
| Client transport tracking | ClientManager tracks transport ID and type |

### External Dependencies

| Dependency      | Type    | Purpose                     |
| --------------- | ------- | --------------------------- |
| `RoomManager`   | Service | Get RouterManager for room  |
| `RouterManager` | Service | Create WebRTC transport     |
| `ClientManager` | Service | Track transport for cleanup |

---

## 2. Event Contract

### Inbound Event

```
Event: transport:create
Direction: C→S
Acknowledgment: ✅ Required (callback)
```

### Zod Schema

```typescript
// src/socket/schemas.ts:129-132
export const transportCreateSchema = z.object({
  type: z.enum(["producer", "consumer"]),
  roomId: roomIdSchema,
});
```

### Payload Schema

```json
{
  "type": "producer" | "consumer",
  "roomId": "string"
}
```

### Field Details

| Field    | Type     | Required | Constraints                  | Example      |
| -------- | -------- | -------- | ---------------------------- | ------------ |
| `type`   | `enum`   | ✅       | `"producer"` or `"consumer"` | `"producer"` |
| `roomId` | `string` | ✅       | min 1 char                   | `"42"`       |

### Acknowledgment Response

```json
// Success
{
  "id": "uuid",                    // Transport ID
  "iceParameters": {
    "usernameFragment": "string",
    "password": "string",
    "iceLite": true
  },
  "iceCandidates": [
    {
      "foundation": "string",
      "priority": 1234567890,
      "ip": "1.2.3.4",
      "port": 10000,
      "type": "host",
      "protocol": "udp"
    }
  ],
  "dtlsParameters": {
    "role": "auto",
    "fingerprints": [
      { "algorithm": "sha-256", "value": "..." }
    ]
  }
}

// Error
{
  "error": "Invalid payload" | "Room not found" | "Server error",
  "details": { ... }  // Only for validation errors
}
```

---

## 3. Event Execution Flow

### 3.1 Entry Point

```
File: src/domains/media/media.handler.ts:17
```

```typescript
socket.on("transport:create", async (rawPayload: unknown, callback) => {
  // Handler logic
});
```

### 3.2 Schema Validation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SCHEMA VALIDATION                                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:19-27                              │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const payloadResult = transportCreateSchema.safeParse(rawPayload);      │ │
│ │ if (!payloadResult.success) {                                           │ │
│ │   if (callback) callback({                                              │ │
│ │     error: "Invalid payload",                                           │ │
│ │     details: payloadResult.error.format(),                              │ │
│ │   });                                                                   │ │
│ │   return;                                                               │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Room Lookup

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ GET ROUTER MANAGER                                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:30-34                              │
│                                                                             │
│ Gets existing room (does NOT create if missing, unlike room:join).          │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const routerMgr = await roomManager.getRoom(roomId);                    │ │
│ │ if (!routerMgr) {                                                       │ │
│ │   if (callback) callback({ error: "Room not found" });                  │ │
│ │   return;                                                               │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.4 Transport Creation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ CREATE WEBRTC TRANSPORT                                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:36-45                              │
│                                                                             │
│ Creates transport with mediasoup, passing isProducer flag.                  │
│ Tracks transport in ClientManager for later cleanup.                        │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const transport = await routerMgr.createWebRtcTransport(                │ │
│ │   type === "producer"                                                   │ │
│ │ );                                                                      │ │
│ │                                                                         │ │
│ │ const client = clientManager.getClient(socket.id);                      │ │
│ │ if (client) {                                                           │ │
│ │   client.transports.set(transport.id, type);                            │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.5 Response

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ RETURN TRANSPORT PARAMETERS                                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:47-54                              │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ if (callback) {                                                         │ │
│ │   callback({                                                            │ │
│ │     id: transport.id,                                                   │ │
│ │     iceParameters: transport.iceParameters,                             │ │
│ │     iceCandidates: transport.iceCandidates,                             │ │
│ │     dtlsParameters: transport.dtlsParameters,                           │ │
│ │   });                                                                   │ │
│ │ }                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. State Transitions

### ClientManager (In-Memory)

| Property            | Before  | After                          |
| ------------------- | ------- | ------------------------------ |
| `client.transports` | `Map()` | `Map({ [transportId]: type })` |

### RouterManager (In-Memory)

| Property     | Before  | After                                     |
| ------------ | ------- | ----------------------------------------- |
| `transports` | `Map()` | `Map({ [transportId]: WebRtcTransport })` |

---

## 5. Reusability Matrix

| Component                               | File                    | Used By            | Reusable | Reasoning |
| --------------------------------------- | ----------------------- | ------------------ | -------- | --------- |
| `transportCreateSchema`                 | `socket/schemas.ts`     | `transport:create` | ✅       | Reusable  |
| `RoomManager.getRoom()`                 | `room/roomManager.ts`   | All media events   | ✅       | Shared    |
| `RouterManager.createWebRtcTransport()` | `room/routerManager.ts` | `transport:create` | ✅       | Core      |

---

## 6. Error Handling & Edge Cases

### Validation Errors

| Error             | Condition | Response             |
| ----------------- | --------- | -------------------- |
| `Invalid payload` | Zod fails | `{ error, details }` |

### Business Logic Errors

| Error            | Condition          | Response    |
| ---------------- | ------------------ | ----------- |
| `Room not found` | Room doesn't exist | `{ error }` |

### System Errors

| Error          | Condition           | Response    |
| -------------- | ------------------- | ----------- |
| `Server error` | mediasoup exception | `{ error }` |

### Edge Cases

| Scenario                 | Behavior                                |
| ------------------------ | --------------------------------------- |
| Room closed mid-creation | Transport fails                         |
| Multiple transports      | Client can have multiple (one per type) |
| Worker crashed           | Transport creation fails                |

---

## 7. Sequence Diagram (Textual)

```
 CLIENT          SOCKET.IO          HANDLER          ROOM_MGR         ROUTER_MGR
   │                  │                  │                │                │
   │  transport:create│                  │                │                │
   │  {type, roomId}  │                  │                │                │
   │─────────────────▶│                  │                │                │
   │                  │ 1. dispatch      │                │                │
   │                  │─────────────────▶│                │                │
   │                  │                  │ 2. validate    │                │
   │                  │                  │                │                │
   │                  │                  │ 3. getRoom     │                │
   │                  │                  │───────────────▶│                │
   │                  │                  │◀───────────────│ routerMgr      │
   │                  │                  │                │                │
   │                  │                  │ 4. createWebRtcTransport       │
   │                  │                  │────────────────────────────────▶│
   │                  │                  │◀────────────────────────────────│
   │                  │                  │                │    transport   │
   │                  │                  │                │                │
   │                  │                  │ 5. track in ClientManager      │
   │                  │                  │                │                │
   │                  │ 6. callback(params)              │                │
   │◀─────────────────│                  │                │                │
```

---

## 8. Cross-Platform Integration

### Frontend Usage (Nuxt)

```typescript
// composables/useMediasoup.ts
const createTransport = async (
  type: "producer" | "consumer",
  roomId: string,
) => {
  const response = await socket.emitWithAck("transport:create", {
    type,
    roomId,
  });

  if (response.error) throw new Error(response.error);

  // Create mediasoup-client transport
  const transport =
    type === "producer"
      ? device.createSendTransport(response)
      : device.createRecvTransport(response);

  // Connect on dtlsconnect event
  transport.on("connect", async ({ dtlsParameters }, callback, errback) => {
    try {
      await socket.emitWithAck("transport:connect", {
        roomId,
        transportId: transport.id,
        dtlsParameters,
      });
      callback();
    } catch (err) {
      errback(err);
    }
  });

  return transport;
};
```

### Laravel Integration

_This event has no direct Laravel integration._

### Related Events

| Event               | Relationship                                |
| ------------------- | ------------------------------------------- |
| `room:join`         | Must be called first to get rtpCapabilities |
| `transport:connect` | Next step - DTLS handshake                  |
| `audio:produce`     | After producer transport connected          |
| `audio:consume`     | After consumer transport connected          |

---

## 9. Extension & Maintenance Notes

### ✅ Where to Add New Features

| Feature Type        | Location                                |
| ------------------- | --------------------------------------- |
| Transport options   | `routerManager.createWebRtcTransport()` |
| Additional tracking | After transport creation (L42-45)       |

### ⚠️ What Should NOT Be Modified Casually

| Item             | Reason                                   |
| ---------------- | ---------------------------------------- |
| Response format  | mediasoup-client expects exact structure |
| Type enum values | Breaking change for clients              |

### 📁 File Locations Quick Reference

| Purpose       | File                                       |
| ------------- | ------------------------------------------ |
| Handler       | `src/domains/media/media.handler.ts:17-59` |
| Schema        | `src/socket/schemas.ts:129-132`            |
| RouterManager | `src/domains/room/routerManager.ts`        |

---

## 10. Document Metadata

| Property               | Value                |
| ---------------------- | -------------------- |
| **Event**              | `transport:create`   |
| **Domain**             | Media                |
| **Direction**          | C→S                  |
| **Author**             | System Documentation |
| **Created**            | 2026-02-09           |
| **Last Updated**       | 2026-02-09           |
| **Node.js Version**    | ≥22.0.0              |
| **TypeScript Version** | ^5.7.0               |

---

_Documentation generated following [MSAB Documentation Standard](../../DOCUMENTATION_STANDARD.md)_
