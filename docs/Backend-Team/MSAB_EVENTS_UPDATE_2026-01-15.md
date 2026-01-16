# MSAB Implementation Update: New Events Added

> **Date**: 2026-01-15  
> **Status**: Laravel events are LIVE, MSAB needs to subscribe

---

## Summary

Laravel has implemented **10 additional events**. Combined with the 2 previously active events, **12 events are now being emitted to Redis**.

---

## Changes Made

### 1. Removed Event

| Event       | Reason                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `gift.sent` | **REMOVED** - Per your feedback, MSAB already broadcasts gifts optimistically. This prevented duplicate animations. |

### 2. New Events Now Active

| Event                          | Receiver                   | Description                                            |
| ------------------------------ | -------------------------- | ------------------------------------------------------ |
| `room.level_up`                | Room owner + room          | Room leveled up                                        |
| `income_target.completed`      | Member + Owner             | Income target completed                                |
| `reward.earned`                | User (private)             | User claimed a reward                                  |
| `agency.invitation`            | Invitee (private)          | User received agency invitation                        |
| `agency.join_request`          | Owner (private)            | Someone requested to join agency                       |
| `agency.join_request_approved` | Requester (private)        | Join request was approved                              |
| `agency.join_request_rejected` | Requester (private)        | Join request was rejected                              |
| `agency.member_kicked`         | Kicked user (private)      | Member was kicked from agency                          |
| `agency.dissolved`             | All members (private each) | Agency was dissolved                                   |
| `config:invalidate`            | Broadcast (all)            | Config cache invalidation (ready, needs admin trigger) |

---

## Event Payloads

### room.level_up

```json
{
  "event": "room.level_up",
  "user_id": 100,
  "room_id": 50,
  "payload": {
    "room_id": 50,
    "room_name": "Star Room",
    "previous_level": 3,
    "new_level": 4,
    "current_xp": "15000.0000"
  }
}
```

### income_target.completed

```json
{
  "event": "income_target.completed",
  "user_id": 123,
  "room_id": null,
  "payload": {
    "target_id": 456,
    "tier": "T2",
    "name": "Silver Target",
    "earned_coins": "50000.0000",
    "member_reward": 100,
    "owner_reward": 50
  }
}
```

> **Note**: Also emits `income_target.member_completed` to agency owner when member completes.

### reward.earned

```json
{
  "event": "reward.earned",
  "user_id": 123,
  "room_id": null,
  "payload": {
    "user_reward_id": 789,
    "reward": {
      "id": 10,
      "name": "Daily Bonus",
      "type": "coins",
      "amount": "100",
      "description": "Daily login reward"
    }
  }
}
```

### agency.invitation

```json
{
  "event": "agency.invitation",
  "user_id": 123,
  "room_id": null,
  "payload": {
    "invitation_id": 456,
    "agency": {
      "id": 1,
      "name": "StarAgency",
      "logo": "https://ik.imagekit.io/..."
    },
    "invited_by": {
      "id": 789,
      "name": "John"
    }
  }
}
```

### agency.join_request

```json
{
  "event": "agency.join_request",
  "user_id": 100,
  "room_id": null,
  "payload": {
    "request_id": 456,
    "user": {
      "id": 123,
      "name": "NewUser",
      "avatar": "https://ik.imagekit.io/..."
    },
    "message": "Please accept me"
  }
}
```

> **Note**: `user_id` is the agency OWNER who should receive this notification.

### agency.join_request_approved

```json
{
  "event": "agency.join_request_approved",
  "user_id": 123,
  "room_id": null,
  "payload": {
    "agency_id": 1,
    "agency_name": "StarAgency"
  }
}
```

### agency.join_request_rejected

```json
{
  "event": "agency.join_request_rejected",
  "user_id": 123,
  "room_id": null,
  "payload": {
    "agency_id": 1,
    "agency_name": "StarAgency"
  }
}
```

### agency.member_kicked

```json
{
  "event": "agency.member_kicked",
  "user_id": 123,
  "room_id": null,
  "payload": {
    "agency_id": 1,
    "agency_name": "StarAgency",
    "reason": "Policy violation"
  }
}
```

### agency.dissolved

```json
{
  "event": "agency.dissolved",
  "user_id": 123,
  "room_id": null,
  "payload": {
    "agency_id": 1,
    "agency_name": "StarAgency"
  }
}
```

> **Note**: Sent to EACH member individually (multiple events).

### config:invalidate

```json
{
  "event": "config:invalidate",
  "user_id": null,
  "room_id": null,
  "payload": {
    "type": "levels",
    "version": null
  }
}
```

> **Note**: `type` can be: `'levels'`, `'badges'`, `'gifts'`, or `'all'`.

---

## MSAB Action Required

### Update Event Router

Add handling for the new event types in your event router:

```javascript
// New events to handle
const newEvents = [
  "room.level_up", // Room-wide
  "income_target.completed", // Private to user
  "income_target.member_completed", // Private to owner
  "reward.earned", // Private to user
  "agency.invitation", // Private to invitee
  "agency.join_request", // Private to owner
  "agency.join_request_approved", // Private to requester
  "agency.join_request_rejected", // Private to requester
  "agency.member_kicked", // Private to kicked user
  "agency.dissolved", // Private to each member
  "config:invalidate", // Broadcast to all
];
```

### Remove gift.sent Handling (if implemented)

Since `gift.sent` is no longer emitted from Laravel, you can remove any specific handling for it (or keep it for your optimistic broadcasts).

---

## Full Event List (12 Active)

| #   | Event                            | Routing                |
| --- | -------------------------------- | ---------------------- |
| 1   | `balance.updated`                | Private to user        |
| 2   | `badge.earned`                   | Private to user        |
| 3   | `room.level_up`                  | Room owner + room      |
| 4   | `income_target.completed`        | Private to member      |
| 5   | `income_target.member_completed` | Private to owner       |
| 6   | `reward.earned`                  | Private to user        |
| 7   | `agency.invitation`              | Private to invitee     |
| 8   | `agency.join_request`            | Private to owner       |
| 9   | `agency.join_request_approved`   | Private to requester   |
| 10  | `agency.join_request_rejected`   | Private to requester   |
| 11  | `agency.member_kicked`           | Private to kicked user |
| 12  | `agency.dissolved`               | Private to each member |
| 13  | `config:invalidate`              | Broadcast to all       |

---

## Testing

Monitor Redis for new events:

```bash
redis-cli -n 3 PSUBSCRIBE "flylive:msab:*"
```

---

## Future Discussion: Push Notifications

Per our discussion, MSAB will be responsible for push notification delivery to offline users. This will be planned separately.
