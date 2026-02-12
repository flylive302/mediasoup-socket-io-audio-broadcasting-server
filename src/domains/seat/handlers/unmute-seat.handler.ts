/**
 * seat:unmute - Owner/Admin unmutes user
 * SEAT-010: Uses shared mute/unmute factory to eliminate code duplication
 */
import { createMuteHandler } from "./mute-unmute.factory.js";
import { Errors } from "@src/shared/errors.js";

export const unmuteSeatHandler = createMuteHandler({
  event: "seat:unmute",
  muted: false,
  failError: Errors.UNMUTE_FAILED,
  producerAction: "resume",
  logAction: "unmuted",
  producerLogAction: "resumed (server-side unmute)",
});
