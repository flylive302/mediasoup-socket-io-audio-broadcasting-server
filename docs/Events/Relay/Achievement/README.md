# Relay Events: Achievement

> **Domain**: Achievement  
> **Direction**: Laravel → MSAB → Frontend  
> **Transport**: Redis Pub/Sub → Socket.IO  
> **Source**: `RELAY_EVENTS.achievement` in `src/integrations/laravel/types.ts`

---

## Events

| Event          | Routing Target | Description           |
| -------------- | -------------- | --------------------- |
| `badge.earned` | User           | User unlocked a badge |
| `level.up`     | User           | User leveled up       |

---

## Payload Schemas

> [!NOTE]
> MSAB does not validate relay payloads. Schemas below are **expected contracts** between Laravel and Frontend. Verify with Laravel source.

### `badge.earned`

```typescript
/** Verify with Laravel: App\Events\Achievement\BadgeEarned */
interface BadgeEarnedPayload {
  badge_id: number;
  badge_name: string;
  badge_icon: string; // URL or asset key
  badge_tier?: string; // e.g., "bronze", "silver", "gold"
  earned_at: string; // ISO 8601
}
```

### `level.up`

```typescript
/** Verify with Laravel: App\Events\Achievement\LevelUp */
interface LevelUpPayload {
  previous_level: number;
  new_level: number;
  xp_type: "wealth" | "charm";
  rewards?: {
    coins?: number;
    diamonds?: number;
    badge_id?: number;
  };
}
```

---

## Frontend Integration

```typescript
// composables/useAchievements.ts
socket.on("badge.earned", (payload: BadgeEarnedPayload) => {
  // Show badge earned animation/toast
});

socket.on("level.up", (payload: LevelUpPayload) => {
  // Show level up celebration, update XP display
});
```

---

## Document Metadata

| Property         | Value                               |
| ---------------- | ----------------------------------- |
| **Created**      | 2026-02-13                          |
| **Last Updated** | 2026-02-13                          |
| **Source**       | `src/integrations/laravel/types.ts` |
