/**
 * Seat Invite Repository — Redis-backed invite management.
 *
 * Handles pending seat invites with TTL expiry and O(1) user→invite
 * reverse index lookups.
 *
 * Extracted from seat.repository.ts for maintainability (M-LP-1).
 */
import type { Redis } from "ioredis";
import type { PendingInvite } from "./seat.types.js";
import { logger } from "@src/infrastructure/logger.js";

// Redis key patterns
const INVITE_KEY = (roomId: string, seatIndex: number) =>
  `room:${roomId}:invite:${seatIndex}`;
const INVITE_USER_KEY = (roomId: string, userId: string) =>
  `room:${roomId}:invite:user:${userId}`;

export class SeatInviteRepository {
  constructor(private readonly redis: Redis) {}

  /**
   * Create a seat invite with TTL.
   * Writes both the invite data key and a reverse index for O(1) user lookup.
   */
  async createInvite(
    roomId: string,
    seatIndex: number,
    targetUserId: string,
    invitedBy: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    try {
      const invite: PendingInvite = {
        targetUserId,
        invitedBy,
        seatIndex,
        createdAt: Date.now(),
      };

      const pipeline = this.redis.pipeline();
      pipeline.setex(
        INVITE_KEY(roomId, seatIndex),
        ttlSeconds,
        JSON.stringify(invite),
      );
      pipeline.setex(
        INVITE_USER_KEY(roomId, targetUserId),
        ttlSeconds,
        seatIndex.toString(),
      );
      await pipeline.exec();

      return true;
    } catch (err) {
      logger.error(
        { err, roomId, seatIndex, targetUserId },
        "Failed to create invite",
      );
      return false;
    }
  }

  /**
   * Get pending invite for a seat
   */
  async getInvite(
    roomId: string,
    seatIndex: number,
  ): Promise<PendingInvite | null> {
    try {
      const data = await this.redis.get(INVITE_KEY(roomId, seatIndex));
      return data ? (JSON.parse(data) as PendingInvite) : null;
    } catch (err) {
      logger.error({ err, roomId, seatIndex }, "Failed to get invite");
      return null;
    }
  }

  /**
   * Delete a pending invite and its reverse index.
   * Reads the invite first to resolve the targetUserId for reverse index cleanup.
   */
  async deleteInvite(roomId: string, seatIndex: number): Promise<boolean> {
    try {
      // Read invite to get targetUserId for reverse index cleanup
      const data = await this.redis.get(INVITE_KEY(roomId, seatIndex));
      const pipeline = this.redis.pipeline();
      pipeline.del(INVITE_KEY(roomId, seatIndex));

      if (data) {
        const invite = JSON.parse(data) as PendingInvite;
        pipeline.del(INVITE_USER_KEY(roomId, invite.targetUserId));
      }

      await pipeline.exec();
      return true;
    } catch (err) {
      logger.error({ err, roomId, seatIndex }, "Failed to delete invite");
      return false;
    }
  }

  /**
   * O(1) invite lookup by target user ID via reverse index.
   * Returns the invite data and seat index, or null if no invite exists.
   */
  async getInviteByUser(
    roomId: string,
    targetUserId: string,
  ): Promise<{ invite: PendingInvite; seatIndex: number } | null> {
    try {
      // Reverse index: room:{roomId}:invite:user:{userId} → seatIndex
      const seatIndexStr = await this.redis.get(
        INVITE_USER_KEY(roomId, targetUserId),
      );
      if (!seatIndexStr) return null;

      const seatIndex = parseInt(seatIndexStr, 10);
      const invite = await this.getInvite(roomId, seatIndex);
      if (!invite || invite.targetUserId !== targetUserId) return null;

      return { invite, seatIndex };
    } catch (err) {
      logger.error(
        { err, roomId, targetUserId },
        "Failed to get invite by user",
      );
      return null;
    }
  }
}
