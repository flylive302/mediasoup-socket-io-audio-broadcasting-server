// One headless client leg. Mirrors the real frontend sequence
// (frontend-nuxt-4-active composables/room/useAudioSocket.ts et al.) against
// the MSAB protocol (src/domains/media/media.handler.ts):
//   connect → room:join (ack carries rtpCapabilities + existingProducers)
//   → transport:create/connect → audio:consume + consumer:resume per producer
//   → (speakers) seat:take → audio:produce with a real Opus-encoded track.
// Ordering rule: NOTHING media-related before the room:join ack — violating it
// trips the server's mediaRoomGateRejections metric (SLO gate Q11, a harness
// bug by definition).

import wrtc from '@roamhq/wrtc';
import { Device } from 'mediasoup-client';
import { io } from 'socket.io-client';
import { attachSink, createSpeakerTrack } from './audio.mjs';

// mediasoup-client expects browser WebRTC globals; @roamhq/wrtc provides them.
for (const key of ['RTCPeerConnection', 'RTCSessionDescription', 'RTCIceCandidate', 'MediaStream', 'MediaStreamTrack']) {
  if (!globalThis[key]) globalThis[key] = wrtc[key];
}
globalThis.navigator ??= { userAgent: 'flylive-load-harness' };

function ack(socket, event, payload, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event}: ack timeout`)), timeoutMs);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      if (res && res.success === false) {
        reject(new Error(`${event}: ${res.error ?? 'unknown error'}`));
      } else {
        resolve(res?.data ?? res);
      }
    });
  });
}

export class Bot {
  constructor({ id, url, origin, token, roomId, role, seatIndex, counters, log, socketOptions }) {
    Object.assign(this, { id, url, origin, token, roomId, role, seatIndex, counters, log, socketOptions });
    this.consumers = new Map();
    this.sinks = [];
    this.speaker = null;
    this.stopped = false;
  }

  async start() {
    this.socket = io(this.url, {
      transports: ['websocket'],
      extraHeaders: { Origin: this.origin },
      auth: { token: this.token, correlationId: `load-harness-bot-${this.id}` },
      reconnection: false,
      ...this.socketOptions,
    });

    await new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('connect_error', (err) => reject(new Error(`connect: ${err.message}`)));
    });

    const joinStarted = performance.now();
    const join = await ack(this.socket, 'room:join', { roomId: this.roomId }, 15000);
    this.counters.joinLatenciesMs.push(performance.now() - joinStarted);

    this.device = new Device({ handlerName: 'Chrome111' });
    await this.device.load({ routerRtpCapabilities: join.rtpCapabilities });

    await this.#setupRecvTransport();
    for (const producer of join.existingProducers ?? []) {
      await this.#consume(producer.producerId ?? producer.id).catch((e) => this.#err('consume-existing', e));
    }
    this.socket.on('audio:newProducer', ({ producerId }) => {
      if (!this.stopped) this.#consume(producerId).catch((e) => this.#err('consume-new', e));
    });
    this.socket.on('audio:producerClosed', ({ producerId }) => this.#closeConsumer(producerId));
    this.socket.on('disconnect', (reason) => {
      if (!this.stopped) this.#err('disconnect', new Error(reason));
    });

    if (this.role === 'speaker') {
      await ack(this.socket, 'seat:take', { roomId: this.roomId, seatIndex: this.seatIndex });
      await this.#setupSendTransport();
      this.speaker = createSpeakerTrack(this.id);
      this.producer = await this.sendTransport.produce({ track: this.speaker.track });
    }
    this.counters.botsConnected += 1;
  }

  async #setupRecvTransport() {
    const info = await ack(this.socket, 'transport:create', { type: 'consumer', roomId: this.roomId });
    this.recvTransport = this.device.createRecvTransport(info);
    this.#wireConnect(this.recvTransport);
  }

  async #setupSendTransport() {
    const info = await ack(this.socket, 'transport:create', { type: 'producer', roomId: this.roomId });
    this.sendTransport = this.device.createSendTransport(info);
    this.#wireConnect(this.sendTransport);
    this.sendTransport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
      ack(this.socket, 'audio:produce', {
        roomId: this.roomId,
        transportId: this.sendTransport.id,
        kind,
        rtpParameters,
        source: 'mic',
      })
        .then(({ id }) => callback({ id }))
        .catch(errback);
    });
  }

  #wireConnect(transport) {
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      ack(this.socket, 'transport:connect', {
        roomId: this.roomId,
        transportId: transport.id,
        dtlsParameters,
      })
        .then(() => callback())
        .catch(errback);
    });
  }

  async #consume(producerId) {
    if (this.consumers.has(producerId)) return;
    const data = await ack(this.socket, 'audio:consume', {
      roomId: this.roomId,
      transportId: this.recvTransport.id,
      producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    });
    const consumer = await this.recvTransport.consume(data);
    this.consumers.set(producerId, consumer);
    this.sinks.push(attachSink(consumer.track, this.counters));
    await ack(this.socket, 'consumer:resume', { roomId: this.roomId, consumerId: consumer.id });
    this.counters.consumersActive += 1;
  }

  #closeConsumer(producerId) {
    const consumer = this.consumers.get(producerId);
    if (consumer) {
      consumer.close();
      this.consumers.delete(producerId);
      this.counters.consumersActive -= 1;
    }
  }

  #err(where, error) {
    this.counters.errors += 1;
    this.log?.(`bot ${this.id} [${where}] ${error.message}`);
  }

  async stop() {
    this.stopped = true;
    try {
      this.speaker?.stop();
      this.producer?.close();
      for (const sink of this.sinks) sink.stop();
      for (const consumer of this.consumers.values()) consumer.close();
      this.recvTransport?.close();
      this.sendTransport?.close();
      if (this.socket?.connected) {
        await ack(this.socket, 'room:leave', { roomId: this.roomId }, 3000).catch(() => {});
      }
    } finally {
      this.socket?.disconnect();
    }
  }
}
