# Media Events

> **Domain**: Media  
> **Source**: `src/domains/media/`

---

## Client → Server (Socket.IO)

| Event               | Handler            | Description              |
| ------------------- | ------------------ | ------------------------ |
| `transport:create`  | `media.handler.ts` | Create WebRTC transport  |
| `transport:connect` | `media.handler.ts` | Connect WebRTC transport |
| `audio:produce`     | `media.handler.ts` | Start producing audio    |
| `audio:consume`     | `media.handler.ts` | Start consuming audio    |
| `audio:selfmute`    | `media.handler.ts` | Self-mute audio          |
| `audio:selfunmute`  | `media.handler.ts` | Self-unmute audio        |
| `consumer:resume`   | `media.handler.ts` | Resume a paused consumer |

See: [transport-create](./transport-create/README.md) · [transport-connect](./transport-connect/README.md) · [audio-produce](./audio-produce/README.md) · [audio-consume](./audio-consume/README.md) · [audio-selfmute](./audio-selfmute/README.md) · [audio-selfunmute](./audio-selfunmute/README.md) · [consumer-resume](./consumer-resume/README.md)

---

## Server → Client (Broadcast)

| Event               | Target            | Description                  |
| ------------------- | ----------------- | ---------------------------- |
| `audio:newProducer` | Room (excl. self) | New audio producer available |
| `speaker:active`    | Room              | Active speaker changed       |

See: [audio-newProducer](./audio-newProducer/README.md) · [speaker-active](./speaker-active/README.md)
