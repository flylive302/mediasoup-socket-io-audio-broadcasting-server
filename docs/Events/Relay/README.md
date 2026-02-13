# Relay Events

> **Direction**: Laravel → MSAB → Frontend  
> **Transport**: Redis Pub/Sub → Socket.IO  
> **Handler**: `EventRouter` (generic pass-through)

---

## Overview

Relay events originate from the **Laravel backend**, are published to the `flylive:msab:events` Redis pub/sub channel, and MSAB relays them to the target user/room socket(s). **MSAB does not process or validate the payload** — it acts as a pure pass-through relay.

> [!IMPORTANT]
> **Event Allowlist Enforced.** Only events registered in `RELAY_EVENTS` (`types.ts`) are relayed. Unregistered events are **rejected** with an error log and a `rejected` metric. You **must** add new events to `RELAY_EVENTS` before publishing from Laravel.

### Routing Logic

| `user_id` | `room_id` | Target                         |
| --------- | --------- | ------------------------------ |
| set       | null      | Emit to user's sockets         |
| null      | set       | Emit to room                   |
| set       | set       | Emit to user's sockets in room |
| null      | null      | Broadcast to all               |

### Source Code

| File                                           | Purpose                            |
| ---------------------------------------------- | ---------------------------------- |
| `src/integrations/laravel/types.ts`            | Event definitions + allowlist      |
| `src/integrations/laravel/event-subscriber.ts` | Redis sub listener                 |
| `src/integrations/laravel/event-router.ts`     | Socket.IO routing + allowlist gate |

---

## Domains

| Domain                                   | Events | Description                        |
| ---------------------------------------- | ------ | ---------------------------------- |
| [Economy](./Economy/README.md)           | 2      | Balance changes, rewards           |
| [Achievement](./Achievement/README.md)   | 2      | Badges, level ups                  |
| [Room](./Room/README.md)                 | 10     | Room levels, membership changes    |
| [IncomeTarget](./IncomeTarget/README.md) | 2      | Income target achievements         |
| [Agency](./Agency/README.md)             | 8      | Invitations, membership, lifecycle |
| [System](./System/README.md)             | 2      | Cache invalidation signals         |

---

## Adding a New Relay Event

1. Add the event string to the appropriate domain group in `RELAY_EVENTS` (`src/integrations/laravel/types.ts`)
   - `KNOWN_EVENT_SET` auto-populates — no extra step needed
2. Create/update the doc in `docs/Events/Relay/<Domain>/README.md`
3. Publish the event from Laravel to the `flylive:msab:events` Redis channel
4. Handle the socket event on the Frontend

> [!CAUTION]
> If you skip step 1, the `EventRouter` will **reject** the event and log an error. This is intentional — it enforces that every event is registered and documented.

---

_Source: [`src/integrations/laravel/types.ts`](../../src/integrations/laravel/types.ts)_
