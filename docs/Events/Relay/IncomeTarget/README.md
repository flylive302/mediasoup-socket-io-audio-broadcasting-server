# Relay Events: Income Target

> **Domain**: Income Target  
> **Direction**: Laravel → MSAB → Frontend  
> **Transport**: Redis Pub/Sub → Socket.IO  
> **Source**: `RELAY_EVENTS.incomeTarget` in `src/integrations/laravel/types.ts`

---

## Events

| Event                            | Routing Target | Description                         |
| -------------------------------- | -------------- | ----------------------------------- |
| `income_target.completed`        | User / Room    | Agency income target fully achieved |
| `income_target.member_completed` | User           | Individual member hit their target  |

---

## Payload Schemas

> [!NOTE]
> MSAB does not validate relay payloads. Schemas below are **expected contracts** between Laravel and Frontend. Verify with Laravel source.

### `income_target.completed`

```typescript
/** Verify with Laravel: App\Events\IncomeTarget\TargetCompleted */
interface IncomeTargetCompletedPayload {
  target_id: number;
  agency_id: number;
  target_name: string;
  target_amount: number;
  achieved_amount: number;
  reward?: {
    type: string;
    amount: number;
  };
}
```

### `income_target.member_completed`

```typescript
/** Verify with Laravel: App\Events\IncomeTarget\MemberCompleted */
interface IncomeTargetMemberCompletedPayload {
  target_id: number;
  agency_id: number;
  user_id: number;
  contribution: number;
  reward?: {
    type: string;
    amount: number;
  };
}
```

---

## Frontend Integration

```typescript
// composables/useIncomeTarget.ts
socket.on(
  "income_target.completed",
  (payload: IncomeTargetCompletedPayload) => {
    // Show celebration, update target progress UI
  },
);

socket.on(
  "income_target.member_completed",
  (payload: IncomeTargetMemberCompletedPayload) => {
    // Show reward notification
  },
);
```

---

## Document Metadata

| Property         | Value                               |
| ---------------- | ----------------------------------- |
| **Created**      | 2026-02-13                          |
| **Last Updated** | 2026-02-13                          |
| **Source**       | `src/integrations/laravel/types.ts` |
