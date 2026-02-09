# Event: `transport:connect`

> **Domain**: Media  
> **Direction**: Client → Server  
> **Transport**: Socket.IO with Acknowledgment  
> **Related Events**: `transport:create` (prerequisite), `audio:produce`, `audio:consume`

---

## 1. Event Overview

### Purpose

Completes the WebRTC transport handshake by connecting a previously created transport with DTLS parameters from the client.

### Business Context

After creating a transport via `transport:create`, the client must connect it before producing or consuming media. This event exchanges DTLS parameters to establish the secure WebRTC connection.

### Key Characteristics

| Property                | Value                                    |
| ----------------------- | ---------------------------------------- |
| Requires Authentication | Yes (via middleware)                     |
| Has Acknowledgment      | Yes                                      |
| Broadcasts              | No                                       |
| Modifies State          | Transport state (connecting → connected) |
| Prerequisite            | `transport:create` must be called first  |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `transportConnectSchema`  
**Source**: `src/socket/schemas.ts:134-138`

```typescript
{
  roomId: string,        // Room ID (1-255 chars, must be joined)
  transportId: string,   // UUID of transport from transport:create
  dtlsParameters: {
    role?: "auto" | "client" | "server",
    fingerprints: Array<{
      algorithm: string,  // e.g., "sha-256"
      value: string
    }>
  }
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
  error: "Invalid payload" | "Transport not found" | "Connect failed";
}
```

---

## 3. Event Execution Flow

### 3.1 Entry Point

```
File: src/domains/media/media.handler.ts:62
```

```typescript
socket.on("transport:connect", async (rawPayload: unknown, callback) => {
  // Handler logic
});
```

### 3.2 Schema Validation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SCHEMA VALIDATION                                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:63-67                              │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const payloadResult = transportConnectSchema.safeParse(rawPayload);     │ │
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
│ File: src/domains/media/media.handler.ts:70-75                              │
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

### 3.4 Transport Connection

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ CONNECT WITH DTLS                                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ File: src/domains/media/media.handler.ts:78-81                              │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ await transport.connect({                                               │ │
│ │   dtlsParameters: dtlsParameters as mediasoup.types.DtlsParameters,     │ │
│ │ });                                                                     │ │
│ │ if (callback) callback({ success: true });                              │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. State Transitions

### Transport State

| State           | Before | After                      |
| --------------- | ------ | -------------------------- |
| dtlsState       | "new"  | "connecting" → "connected" |
| connectionState | "new"  | "connected"                |

---

## 5. Reusability Matrix

| Component                  | Used For                                   |
| -------------------------- | ------------------------------------------ |
| `transportConnectSchema`   | Validates DTLS parameters and transport ID |
| `roomManager.getRoom()`    | Retrieves RouterManager by room ID         |
| `routerMgr.getTransport()` | Retrieves WebRTC transport by ID           |

---

## 6. Error Handling

| Error                 | Cause                           | Response                                |
| --------------------- | ------------------------------- | --------------------------------------- |
| `Invalid payload`     | Schema validation fails         | Return error, no state change           |
| `Transport not found` | Room or transport doesn't exist | Return error                            |
| `Connect failed`      | DTLS handshake error            | Return error, transport may be unusable |

---

## 7. Sequence Diagram

```
Client                    MSAB                      Mediasoup
   │                        │                           │
   │──transport:connect────▶│                           │
   │   {roomId,             │                           │
   │    transportId,        │                           │
   │    dtlsParameters}     │                           │
   │                        │                           │
   │                        │──transport.connect()─────▶│
   │                        │   (DTLS handshake)        │
   │                        │                           │
   │                        │◀──connection established──│
   │                        │                           │
   │◀──{success: true}──────│                           │
   │                        │                           │
```

---

## 8. Cross-Platform Integration

### Frontend (Nuxt)

- Call after `transport:create` returns transport parameters
- Pass DTLS parameters from `device.createSendTransport()` or `device.createRecvTransport()`
- Must complete before `audio:produce` or `audio:consume`

### WebRTC Flow

```
1. transport:create → Get server transport params
2. device.createSendTransport(params) → Local transport
3. transport.on('connect', ({dtlsParameters}, callback) => {
     socket.emit('transport:connect', {...}, callback);
   });
4. transport.produce() or transport.consume()
```

---

## 9. Extension & Maintenance Notes

- Transport connection is **idempotent** - calling twice on same transport is safe
- DTLS handshake timeout handled by mediasoup internally
- Consider adding connection state tracking in ClientManager for debugging

---

## 10. Document Metadata

| Property | Value                                |
| -------- | ------------------------------------ |
| Created  | 2026-02-09                           |
| Handler  | `src/domains/media/media.handler.ts` |
| Lines    | 62-86                                |
| Schema   | `src/socket/schemas.ts:134-138`      |
