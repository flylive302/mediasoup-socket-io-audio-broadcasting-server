/**
 * ICE Server Configuration
 *
 * Builds RTCIceServer[] from environment config for WebRTC NAT traversal.
 * Returned in transport:create responses so the frontend can pass them
 * to mediasoup-client's createSendTransport() / createRecvTransport().
 *
 * STUN servers help clients discover their public IP.
 * TURN servers relay media when direct connectivity is blocked.
 */
import { config } from "./index.js";

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Cached result — config is immutable after startup */
let _cached: IceServer[] | null = null;

/**
 * Returns the ICE server list derived from environment configuration.
 * Result is computed once and cached for the process lifetime.
 */
export function getIceServers(): IceServer[] {
  if (_cached) return _cached;

  const servers: IceServer[] = [];

  // STUN servers (no auth required)
  if (config.ICE_STUN_URLS.length > 0) {
    servers.push({ urls: config.ICE_STUN_URLS });
  }

  // TURN servers (require credentials)
  if (
    config.ICE_TURN_URLS.length > 0 &&
    config.ICE_TURN_USERNAME &&
    config.ICE_TURN_CREDENTIAL
  ) {
    servers.push({
      urls: config.ICE_TURN_URLS,
      username: config.ICE_TURN_USERNAME,
      credential: config.ICE_TURN_CREDENTIAL,
    });
  }

  _cached = servers;
  return _cached;
}
