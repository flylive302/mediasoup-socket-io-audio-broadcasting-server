# Relay Events: Economy

> **Domain**: Economy  
> **Direction**: Laravel → MSAB → Frontend  
> **Transport**: Redis Pub/Sub → Socket.IO  
> **Source**: `RELAY_EVENTS.economy` in `src/integrations/laravel/types.ts`

---

## Events

| Event             | Routing Target | Description                         |
| ----------------- | -------------- | ----------------------------------- |
| `balance.updated` | User           | User's coin/diamond balance changed |
| `reward.earned`   | User           | User earned a reward (daily, quest) |

---

## Payload Schemas

> [!NOTE]
> MSAB does not validate relay payloads. Schemas below are **expected contracts** between Laravel and Frontend. Verify with Laravel source.

### `balance.updated`

```typescript
/** Verify with Laravel: App\Events\Economy\BalanceUpdated */
interface BalanceUpdatedPayload {
  coins: number;
  diamonds: number;
  change: {
    type: "credit" | "debit";
    amount: number;
    currency: "coins" | "diamonds";
    reason: string; // e.g., "gift_sent", "exchange", "purchase"
  };
}
```

### `reward.earned`

```typescript
/** Verify with Laravel: App\Events\Economy\RewardEarned */
interface RewardEarnedPayload {
  reward_id: number;
  reward_type: string; // e.g., "daily_login", "quest", "achievement"
  reward_name: string;
  amount: number;
  currency: "coins" | "diamonds";
}
```

---

## Frontend Integration

```typescript
// composables/useEconomy.ts or stores/economy.ts
socket.on("balance.updated", (payload: BalanceUpdatedPayload) => {
  // Update balance display in header/wallet
});

socket.on("reward.earned", (payload: RewardEarnedPayload) => {
  // Show reward toast/animation
});
```

---

## Document Metadata

| Property         | Value                               |
| ---------------- | ----------------------------------- |
| **Created**      | 2026-02-13                          |
| **Last Updated** | 2026-02-13                          |
| **Source**       | `src/integrations/laravel/types.ts` |
