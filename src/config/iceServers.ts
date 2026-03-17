/**
 * ICE Server Configuration — Dynamic Cloudflare TURN Credentials
 *
 * When CLOUDFLARE_TURN_API_KEY + CLOUDFLARE_TURN_KEY_ID are set, this module
 * fetches short-lived TURN credentials from Cloudflare's API and caches them
 * for 23 hours (1h before Cloudflare's 24h TTL expires), refreshing automatically.
 *
 * Fallback: If only STUN is configured (no TURN API keys), only STUN is returned.
 * This lets the server boot and work without TURN, and TURN is added via env vars.
 */
import { config } from "./index.js";
import { logger } from "@src/infrastructure/logger.js";

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// Cloudflare caps credentials TTL at 86400s (24h). We refresh 1h early.
const CF_TURN_TTL_SECONDS = 86400;
const REFRESH_BUFFER_MS = 60 * 60 * 1000; // 1 hour before expiry

interface TurnCredentialCache {
  servers: IceServer[];
  expiresAt: number; // epoch ms
}

let _cache: TurnCredentialCache | null = null;

/**
 * Fetches fresh TURN credentials from Cloudflare Realtime API.
 * Cloudflare caps TTL at 86400 seconds — credentials are short-lived by design.
 */
async function fetchCloudflareCredentials(): Promise<IceServer[]> {
  const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${config.CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.CLOUDFLARE_TURN_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttl: CF_TURN_TTL_SECONDS }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Cloudflare TURN API error ${response.status}: ${body.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as {
    iceServers: Array<{
      urls: string[];
      username?: string;
      credential?: string;
    }>;
  };

  return data.iceServers.map((s) => ({
    urls: s.urls,
    ...(s.username && { username: s.username }),
    ...(s.credential && { credential: s.credential }),
  }));
}

/**
 * Returns the ICE server list.
 *
 * - With Cloudflare API keys: fetches dynamic TURN credentials, cached for 23h,
 *   auto-refreshed on next call after expiry.
 * - Without API keys: returns STUN-only (from ICE_STUN_URLS config).
 */
export async function getIceServers(): Promise<IceServer[]> {
  const hasTurnConfig =
    config.CLOUDFLARE_TURN_API_KEY && config.CLOUDFLARE_TURN_KEY_ID;

  if (!hasTurnConfig) {
    // STUN only — no credentials needed, no expiry
    if (config.ICE_STUN_URLS.length === 0) return [];
    return [{ urls: config.ICE_STUN_URLS }];
  }

  // Return cached credentials if still valid
  if (_cache && Date.now() < _cache.expiresAt) {
    return _cache.servers;
  }

  // Fetch fresh credentials
  try {
    const servers = await fetchCloudflareCredentials();
    _cache = {
      servers,
      expiresAt: Date.now() + CF_TURN_TTL_SECONDS * 1000 - REFRESH_BUFFER_MS,
    };
    logger.info(
      { serverCount: servers.length, expiresIn: "23h" },
      "Cloudflare TURN credentials refreshed",
    );
    return servers;
  } catch (error) {
    logger.error({ error }, "Failed to fetch Cloudflare TURN credentials");
    // Serve stale cache if available rather than failing the transport creation
    if (_cache) {
      logger.warn("Serving stale TURN credentials after fetch failure");
      return _cache.servers;
    }
    // Last resort: STUN only
    return config.ICE_STUN_URLS.length > 0
      ? [{ urls: config.ICE_STUN_URLS }]
      : [];
  }
}
