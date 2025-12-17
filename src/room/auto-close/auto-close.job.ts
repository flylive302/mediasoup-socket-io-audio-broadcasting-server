/**
 * Room Auto-Close Job
 * Background job that periodically checks for inactive rooms and closes them
 */
import { logger } from "../../core/logger.js";
import { config } from "../../config/index.js";
import type { AutoCloseService } from "./auto-close.service.js";

export type RoomCloseCallback = (roomId: string, reason: string) => Promise<void>;

export class AutoCloseJob {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly autoCloseService: AutoCloseService,
    private readonly onRoomClose: RoomCloseCallback
  ) {}

  /**
   * Start the background job
   */
  start(): void {
    if (this.timer) {
      logger.warn("Auto-close job already running");
      return;
    }

    this.timer = setInterval(
      () => void this.checkInactiveRooms(),
      config.ROOM_AUTO_CLOSE_POLL_INTERVAL_MS
    );

    logger.info(
      { pollIntervalMs: config.ROOM_AUTO_CLOSE_POLL_INTERVAL_MS },
      "Room auto-close job started"
    );
  }

  /**
   * Stop the background job gracefully
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("Room auto-close job stopped");
    }
  }

  /**
   * Check for inactive rooms and close them
   */
  private async checkInactiveRooms(): Promise<void> {
    // Prevent concurrent runs
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    try {
      const inactiveRoomIds = await this.autoCloseService.getInactiveRoomIds();

      if (inactiveRoomIds.length > 0) {
        logger.info(
          { count: inactiveRoomIds.length, roomIds: inactiveRoomIds },
          "Found inactive rooms to close"
        );
      }

      for (const roomId of inactiveRoomIds) {
        try {
          await this.onRoomClose(roomId, "inactivity");
          logger.info({ roomId }, "Closed inactive room");
        } catch (err) {
          logger.error({ err, roomId }, "Failed to close inactive room");
        }
      }
    } catch (err) {
      logger.error({ err }, "Auto-close job error");
    } finally {
      this.isRunning = false;
    }
  }
}
