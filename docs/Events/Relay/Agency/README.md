# Relay Events: Agency

> **Domain**: Agency  
> **Direction**: Laravel → MSAB → Frontend  
> **Transport**: Redis Pub/Sub → Socket.IO  
> **Source**: `RELAY_EVENTS.agency` in `src/integrations/laravel/types.ts`

---

## Events

| Event                          | Routing Target | Description                              |
| ------------------------------ | -------------- | ---------------------------------------- |
| `agency.invitation`            | User           | User receives an agency invitation       |
| `agency.join_request`          | User           | Agency owner gets a join request         |
| `agency.join_request_approved` | User           | Requester notified: request approved     |
| `agency.join_request_rejected` | User           | Requester notified: request rejected     |
| `agency.member_kicked`         | User           | Member notified they were kicked         |
| `agency.member_joined`         | User           | Agency owner notified: new member joined |
| `agency.member_left`           | User           | Agency owner notified: member left       |
| `agency.dissolved`             | User           | All agency members notified: agency gone |

---

## Payload Schemas

> [!NOTE]
> MSAB does not validate relay payloads. Schemas below are **expected contracts** between Laravel and Frontend. Verify with Laravel source.

### `agency.invitation`

```typescript
/** Verify with Laravel: App\Events\Agency\InvitationSent */
interface AgencyInvitationPayload {
  invitation_id: number;
  agency_id: number;
  agency_name: string;
  invited_by: {
    id: number;
    name: string;
    avatar: string;
  };
}
```

### `agency.join_request`

```typescript
/** Verify with Laravel: App\Events\Agency\JoinRequestCreated */
interface AgencyJoinRequestPayload {
  request_id: number;
  agency_id: number;
  user: {
    id: number;
    name: string;
    avatar: string;
  };
}
```

### `agency.join_request_approved`

```typescript
/** Verify with Laravel */
interface AgencyJoinRequestApprovedPayload {
  agency_id: number;
  agency_name: string;
}
```

### `agency.join_request_rejected`

```typescript
/** Verify with Laravel */
interface AgencyJoinRequestRejectedPayload {
  agency_id: number;
  agency_name: string;
  reason?: string;
}
```

### `agency.member_kicked`

```typescript
/** Verify with Laravel */
interface AgencyMemberKickedPayload {
  agency_id: number;
  agency_name: string;
  reason?: string;
}
```

### `agency.member_joined`

```typescript
/** Verify with Laravel */
interface AgencyMemberJoinedPayload {
  agency_id: number;
  user: {
    id: number;
    name: string;
    avatar: string;
  };
}
```

### `agency.member_left`

```typescript
/** Verify with Laravel */
interface AgencyMemberLeftPayload {
  agency_id: number;
  user: {
    id: number;
    name: string;
  };
}
```

### `agency.dissolved`

```typescript
/** Verify with Laravel */
interface AgencyDissolvedPayload {
  agency_id: number;
  agency_name: string;
  dissolved_by: number;
}
```

---

## Frontend Integration

```typescript
// composables/useAgency.ts
socket.on("agency.invitation", (payload: AgencyInvitationPayload) => {
  // Show invitation notification/modal
});

socket.on("agency.join_request", (payload: AgencyJoinRequestPayload) => {
  // Show pending request to agency owner
});

socket.on("agency.join_request_approved", (payload) => {
  // Update agency membership state
});

socket.on("agency.dissolved", (payload) => {
  // Clear agency data, show notification
});
```

---

## Document Metadata

| Property         | Value                               |
| ---------------- | ----------------------------------- |
| **Created**      | 2026-02-13                          |
| **Last Updated** | 2026-02-13                          |
| **Source**       | `src/integrations/laravel/types.ts` |
