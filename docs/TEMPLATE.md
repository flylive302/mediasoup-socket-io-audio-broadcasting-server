# Event Documentation Template

> **Copy this file** when creating documentation for a new Socket.IO event.  
> Replace all placeholders with actual values.
> Delete this header section after copying.

---

# `EVENT_NAME` Event

> **Domain**: DOMAIN_NAME  
> **Direction**: C→S / S→C / C↔S  
> **Handler**: `src/domains/DOMAIN/HANDLER.ts`

---

## 1. Event Overview

### Event: `event:name` (DIRECTION)

### Purpose

Brief description of what this event does.

### Domain

**DOMAIN_NAME** - Brief domain description

### Responsibilities

- [ ] Responsibility 1
- [ ] Responsibility 2
- [ ] Responsibility 3

### What It Owns

| Owned   | Description |
| ------- | ----------- |
| Thing 1 | Description |
| Thing 2 | Description |

### External Dependencies

| Dependency   | Type           | Purpose |
| ------------ | -------------- | ------- |
| Dependency 1 | HTTP/Redis/etc | Purpose |

---

## 2. Event Contract

### Inbound Event

```
Event: event:name
Direction: C→S
Acknowledgment: ✅ Required / ❌ Not used
```

### Zod Schema

```typescript
// src/socket/schemas.ts
export const eventNameSchema = z.object({
  // fields
});
```

### Payload Schema

```json
{
  "field1": "type",
  "field2": "type"
}
```

### Field Details

| Field    | Type     | Required | Constraints  | Example     |
| -------- | -------- | -------- | ------------ | ----------- |
| `field1` | `string` | ✅       | constraints  | `"example"` |
| `field2` | `number` | ❌       | positive int | `123`       |

### Acknowledgment Response

```json
// Success
{
  "data": "..."
}

// Error
{
  "error": "Error message"
}
```

### Emitted Events

| Event             | Target    | When           |
| ----------------- | --------- | -------------- |
| `event:broadcast` | Room/User | When triggered |

---

## 3. Event Execution Flow

### 3.1 Entry Point

```
File: src/domains/DOMAIN/handler.ts:LINE
```

```typescript
socket.on("event:name", async (payload, ack) => {
  // ...
});
```

### 3.2 Schema Validation

┌─────────────────────────────────────────────────────────────────────────────┐
│ VALIDATION │
│─────────────────────────────────────────────────────────────────────────────│
│ File: src/domains/DOMAIN/handler.ts:LINE │
│ │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ const result = schema.safeParse(payload); │ │
│ │ if (!result.success) { ... } │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘

### 3.3 Handler Logic

Description of main handler logic.

┌─────────────────────────────────────────────────────────────────────────────┐
│ MAIN LOGIC │
│─────────────────────────────────────────────────────────────────────────────│
│ File: src/domains/DOMAIN/handler.ts:LINE │
│ │
│ Description of operation │
│ │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ // Key code snippet │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘

### 3.4 Service Layer Calls

Description of service/manager calls.

### 3.5 State Updates

Description of state modifications.

### 3.6 Broadcasts/Responses

Description of final outputs.

---

## 4. State Transitions

### In-Memory State

| Manager       | Property | Before      | After      |
| ------------- | -------- | ----------- | ---------- |
| ClientManager | `roomId` | `undefined` | `"roomId"` |

### Redis State

| Key Pattern   | Operation | TTL          |
| ------------- | --------- | ------------ |
| `prefix:{id}` | GET/SET   | None/Seconds |

### Socket.IO Rooms

| Room     | Action              |
| -------- | ------------------- |
| `roomId` | `socket.join/leave` |

---

## 5. Reusability Matrix

| Component   | File              | Used By          | Reusable | Reasoning |
| ----------- | ----------------- | ---------------- | -------- | --------- |
| Component 1 | `path/to/file.ts` | Event A, Event B | ✅/❌/⭕ | Reason    |

---

## 6. Error Handling & Edge Cases

### Validation Errors

| Error           | Condition    | Response                       |
| --------------- | ------------ | ------------------------------ |
| Invalid payload | Schema fails | `{ error: "Invalid payload" }` |

### Business Logic Errors

| Error     | Condition              | Response                 |
| --------- | ---------------------- | ------------------------ |
| Not found | Resource doesn't exist | `{ error: "Not found" }` |

### System Errors

| Error          | Condition        | Response                      |
| -------------- | ---------------- | ----------------------------- |
| Internal error | Exception thrown | `{ error: "Internal error" }` |

### Edge Cases

| Scenario    | Behavior     |
| ----------- | ------------ |
| Edge case 1 | What happens |

---

## 7. Sequence Diagram (Textual)

```
 CLIENT           SOCKET.IO          HANDLER            SERVICE          REDIS/MEDIASOUP
   │                  │                  │                  │                   │
   │  event:name      │                  │                  │                   │
   │─────────────────▶│                  │                  │                   │
   │                  │ 1. dispatch      │                  │                   │
   │                  │─────────────────▶│                  │                   │
   │                  │                  │ 2. validate      │                   │
   │                  │                  │ ─ ─ ─ ─ ─ ─ ─ ─ ▶│                   │
   │                  │                  │                  │ 3. state op       │
   │                  │                  │                  │──────────────────▶│
   │                  │                  │                  │◀──────────────────│
   │                  │                  │◀─ ─ ─ ─ ─ ─ ─ ─ ─│                   │
   │                  │ 4. ack           │                  │                   │
   │◀─────────────────│                  │                  │                   │
   │                  │                  │                  │                   │
```

---

## 8. Cross-Platform Integration

### Frontend Usage (Nuxt)

```typescript
// composables/useDomain.ts
const handleEvent = async (payload: PayloadType) => {
  const response = await socket.emitWithAck("event:name", payload);
  if (response.error) throw new Error(response.error);
  return response;
};
```

### Laravel Integration

| Endpoint       | When Called       | Purpose |
| -------------- | ----------------- | ------- |
| `METHOD /path` | Trigger condition | Purpose |

_Or: "This event has no direct Laravel integration."_

### Related Events

| Event           | Relationship      |
| --------------- | ----------------- |
| `related:event` | Brief description |

---

## 9. Extension & Maintenance Notes

### ✅ Where to Add New Features

| Feature Type   | Location                          |
| -------------- | --------------------------------- |
| New field      | `src/socket/schemas.ts` + handler |
| New validation | Handler file                      |

### 📝 Modification Guide

```typescript
// To add new functionality:
// 1. Update schema in src/socket/schemas.ts
// 2. Add logic in handler
// 3. Update tests
```

### ⚠️ What Should NOT Be Modified Casually

| Item               | Reason                      |
| ------------------ | --------------------------- |
| Schema field names | Breaking change for clients |

### 🚨 Common Pitfalls

| Pitfall        | Solution     |
| -------------- | ------------ |
| Common mistake | How to avoid |

### 📁 File Locations Quick Reference

| Purpose | File                            |
| ------- | ------------------------------- |
| Handler | `src/domains/DOMAIN/handler.ts` |
| Schema  | `src/socket/schemas.ts`         |
| Types   | `src/domains/DOMAIN/types.ts`   |

---

## 10. Document Metadata

| Property               | Value                |
| ---------------------- | -------------------- |
| **Event**              | `event:name`         |
| **Domain**             | DOMAIN_NAME          |
| **Direction**          | C→S                  |
| **Author**             | System Documentation |
| **Created**            | YYYY-MM-DD           |
| **Last Updated**       | YYYY-MM-DD           |
| **Node.js Version**    | ≥22.0.0              |
| **TypeScript Version** | ^5.7.0               |

---

_Documentation generated following [MSAB Documentation Standard](../DOCUMENTATION_STANDARD.md)_
