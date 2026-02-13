# Gift Events

> **Domain**: Gift  
> **Source**: `src/domains/gift/`

---

## Client → Server (Socket.IO)

| Event          | Handler          | Description              |
| -------------- | ---------------- | ------------------------ |
| `gift:prepare` | `giftHandler.ts` | Prepare gift transaction |
| `gift:send`    | `giftHandler.ts` | Send a gift              |

See: [prepare](./prepare/README.md) · [send](./send/README.md)

---

## Server → Client (Broadcast)

| Event           | Target        | Description           |
| --------------- | ------------- | --------------------- |
| `gift:received` | Room          | Gift received in room |
| `gift:error`    | Sender socket | Gift processing error |

See: [gift-received](./gift-received/README.md) · [gift-error](./gift-error/README.md)
