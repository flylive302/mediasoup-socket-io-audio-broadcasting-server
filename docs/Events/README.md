# Events Directory

> Master index of all events flowing through MSAB

---

## Domains

Each domain folder contains a README listing all its events (Client→Server, Server→Client, and Relay).

| Domain                     | C→S | S→C | Relay | Total |
| -------------------------- | --- | --- | ----- | ----- |
| [Room](./Room/README.md)   | 2   | 3   | 10    | 15    |
| [Seat](./Seat/README.md)   | 12  | 6   | —     | 18    |
| [Media](./Media/README.md) | 7   | 2   | —     | 9     |
| [Gift](./Gift/README.md)   | 2   | 2   | —     | 4     |
| [Chat](./Chat/README.md)   | 1   | —   | —     | 1     |
| [User](./User/README.md)   | 1   | —   | —     | 1     |

## Relay-Only Domains

These domains have no socket handlers in MSAB — events are relayed from Laravel to Frontend.

| Domain                                          | Events | Description                |
| ----------------------------------------------- | ------ | -------------------------- |
| [Economy](./Relay/Economy/README.md)            | 2      | Balance changes, rewards   |
| [Achievement](./Relay/Achievement/README.md)    | 2      | Badges, level ups          |
| [Income Target](./Relay/IncomeTarget/README.md) | 2      | Income target achievements |
| [Agency](./Relay/Agency/README.md)              | 8      | Invitations, membership    |
| [System](./Relay/System/README.md)              | 2      | Cache invalidation         |

📖 See [Relay Events overview](./Relay/README.md) for routing logic and architecture.

---

## Event Count Summary

| Direction          | Count  | Description                     |
| ------------------ | ------ | ------------------------------- |
| Client → Server    | 25     | Frontend sends, MSAB processes  |
| Server → Client    | 13     | MSAB emits to room/user sockets |
| Laravel → Frontend | 26     | Laravel publishes, MSAB relays  |
| **Total**          | **64** | All events flowing through MSAB |
