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

After `transport:create`, the client must connect the transport before producing or consuming media. This exchanges DTLS parameters to establish the secure WebRTC connection.

### Key Characteristics

| Property                | Value                                    |
| ----------------------- | ---------------------------------------- |
| Requires Authentication | Yes (via middleware)                     |
| Has Acknowledgment      | Yes (via createHandler)                  |
| Broadcasts              | No                                       |
| Modifies State          | Transport state (connecting → connected) |
| Prerequisite            | `transport:create` must be called first  |

---

## 2. Event Contract

### 2.1 Client Payload (Input)

**Schema**: `transportConnectSchema`  
**Source**: `src/socket/schemas.ts`

```typescript
export const transportConnectSchema = z.object({
  roomId: roomIdSchema,
  transportId: z.string(),
  dtlsParameters: z.any(), // mediasoup DtlsParameters (complex nested object)
});
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
  success: false,
  error: "INVALID_PAYLOAD" | "Transport not found" | "INTERNAL_ERROR"
}
```

---

## 3. Event Execution Flow

### 3.1 Entry Point

```typescript
const transportConnectHandler = createHandler(
  "transport:connect",
  transportConnectSchema,
  async (payload, _socket, context) => { ... }
);
```

### 3.2 Execution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION FLOW                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. createHandler validates payload + room membership                        │
│ 2. Look up room cluster and transport via cluster.getTransport(transportId)│
│ 3. If not found → { success: false, error: "Transport not found" }         │
│ 4. Call transport.connect({ dtlsParameters })                               │
│ 5. Return { success: true }                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Document Metadata

| Property         | Value                                |
| ---------------- | ------------------------------------ |
| **Event**        | `transport:connect`                  |
| **Domain**       | Media                                |
| **Direction**    | C→S                                  |
| **Created**      | 2026-02-09                           |
| **Last Updated** | 2026-02-12                           |
| **Handler**      | `src/domains/media/media.handler.ts` |

### Schema Change Log

| Date       | Change                                               |
| ---------- | ---------------------------------------------------- |
| 2026-02-12 | Handler migrated to `createHandler` pattern (CQ-001) |
| 2026-02-12 | ACK response wrapped in `{ success }` envelope       |

---

_Documentation generated following [MSAB Documentation Standard](../../../DOCUMENTATION_STANDARD.md)_
