/**
 * seat:mute - Owner/Admin mutes user
 * SEAT-010: Uses shared mute/unmute factory to eliminate code duplication
 */
import { createMuteHandler } from "./mute-unmute.factory.js";
import { Errors } from "@src/shared/errors.js";

export const muteSeatHandler = createMuteHandler({
  event: "seat:mute",
  muted: true,
  failError: Errors.MUTE_FAILED,
  producerAction: "pause",
  logAction: "muted",
  producerLogAction: "paused (server-side mute)",
});
