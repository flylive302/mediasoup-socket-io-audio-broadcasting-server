# Relay Events: System

> **Domain**: System  
> **Direction**: Laravel → MSAB → Frontend  
> **Transport**: Redis Pub/Sub → Socket.IO  
> **Source**: `RELAY_EVENTS.system` in `src/integrations/laravel/types.ts`

---

## Events

| Event               | Routing Target | Description                             |
| ------------------- | -------------- | --------------------------------------- |
| `config:invalidate` | Broadcast      | Invalidate cached config on all clients |
| `asset:invalidate`  | Broadcast      | Invalidate cached assets on all clients |

---

## Payload Schemas

> [!NOTE]
> MSAB does not validate relay payloads. Schemas below are **expected contracts** between Laravel and Frontend. Verify with Laravel source.

### `config:invalidate`

```typescript
/** Verify with Laravel */
interface ConfigInvalidatePayload {
  keys?: string[]; // Specific config keys to invalidate (null = all)
  reason?: string; // e.g., "admin_update", "deployment"
}
```

### `asset:invalidate`

```typescript
/** Verify with Laravel */
interface AssetInvalidatePayload {
  asset_types?: string[]; // e.g., ["gifts", "frames", "badges"] (null = all)
  version?: string; // New asset version identifier
}
```

---

## Frontend Integration

```typescript
// composables/useConfig.ts
socket.on("config:invalidate", (payload: ConfigInvalidatePayload) => {
  // Clear config cache, refetch from API
});

socket.on("asset:invalidate", (payload: AssetInvalidatePayload) => {
  // Clear asset cache, refetch assets
});
```

---

## Document Metadata

| Property         | Value                               |
| ---------------- | ----------------------------------- |
| **Created**      | 2026-02-13                          |
| **Last Updated** | 2026-02-13                          |
| **Source**       | `src/integrations/laravel/types.ts` |
