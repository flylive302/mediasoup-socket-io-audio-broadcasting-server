import { describe, it, expect } from "vitest";
import {
  chatMessageSchema,
  audioProduceSchema,
  transportCreateSchema,
} from "./schemas.js";

describe("Message Schemas", () => {
  it("validates correct chat message", () => {
    const payload = {
      roomId: "123e4567-e89b-12d3-a456-426614174000",
      content: "Hello World",
      type: "text",
    };
    const result = chatMessageSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("rejects invalid chat message (too long)", () => {
    const payload = {
      roomId: "123e4567-e89b-12d3-a456-426614174000",
      content: "a".repeat(501),
    };
    const result = chatMessageSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects empty content", () => {
    const payload = {
      roomId: "123e4567-e89b-12d3-a456-426614174000",
      content: "",
    };
    const result = chatMessageSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

describe("Transport Schemas", () => {
  it("validates transport creation", () => {
    const payload = {
      type: "producer",
      roomId: "123e4567-e89b-12d3-a456-426614174000",
    };
    const result = transportCreateSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("rejects invalid transport type", () => {
    const payload = {
      type: "invalid",
      roomId: "123e4567-e89b-12d3-a456-426614174000",
    };
    const result = transportCreateSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

describe("Audio Schemas", () => {
  it("validates audio produce", () => {
    const payload = {
      roomId: "123e4567-e89b-12d3-a456-426614174000",
      transportId: "123e4567-e89b-12d3-a456-426614174001",
      kind: "audio",
      rtpParameters: { codecs: [] },
    };
    const result = audioProduceSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});
