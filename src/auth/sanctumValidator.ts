import type { Redis } from "ioredis";
import type { Logger } from "../core/logger.js";
import { config } from "../config/index.js";
import type { AuthenticatedUser } from "./types.js";
import { hashToken } from "../utils/crypto.js";

const CACHE_TTL = 300; // 5 minutes
const CACHE_PREFIX = "auth:token:";

export class SanctumValidator {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  /**
   * Validates a Sanctum token and returns the authenticated user
   * Uses Redis cache to minimize Laravel API calls
   */
  async validate(token: string): Promise<AuthenticatedUser | null> {
    const cacheKey = `${CACHE_PREFIX}${hashToken(token)}`;
    const revokedKey = `auth:revoked:${hashToken(token)}`;

    // 0. Check revocation FIRST
    try {
      const isRevoked = await this.redis.exists(revokedKey);
      if (isRevoked) {
        this.logger.warn(
          "Attempted use of revoked token (validated via Redis)",
        );
        // Invalidate cache just in case
        await this.redis.del(cacheKey);
        return null;
      }
    } catch (err) {
      this.logger.error({ err }, "Redis error during token revocation check");
      // Proceed cautiously or fail open? Fail closed for security.
      return null;
    }

    // 1. Check cache
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        this.logger.debug("Token validated from cache");
        return JSON.parse(cached) as AuthenticatedUser;
      }
    } catch (err) {
      this.logger.error({ err }, "Redis error during token cache check");
      // Continue to API if cache fails
    }

    // 2. Validate against Laravel API
    try {
      // Timeout after 10 seconds to prevent hanging
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      let response: Response;
      try {
        response = await fetch(
          `${config.LARAVEL_API_URL}/api/v1/internal/auth/validate`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              "X-Internal-Key": config.LARAVEL_INTERNAL_KEY,
            },
            signal: controller.signal,
          },
        );
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        this.logger.warn(
          { status: response.status },
          "Laravel token validation failed",
        );
        return null;
      }

      const user = (await response.json()) as AuthenticatedUser;

      // 3. Cache the validated token
      try {
        await this.redis.setex(cacheKey, CACHE_TTL, JSON.stringify(user));
      } catch (err) {
        this.logger.error({ err }, "Failed to cache validated token");
      }

      return user;
    } catch (error) {
      this.logger.error({ error }, "Laravel API request failed");
      return null;
    }
  }
}
