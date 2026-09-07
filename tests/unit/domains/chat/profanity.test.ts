import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

describe("maskProfanity", () => {
  it("leaves clean text unchanged", async () => {
    const { maskProfanity } = await import("@src/domains/chat/profanity.js");
    const result = maskProfanity("Hello there, how are you today?");
    expect(result).toEqual({ text: "Hello there, how are you today?", masked: false });
  });

  it("masks a basic profane word", async () => {
    const { maskProfanity } = await import("@src/domains/chat/profanity.js");
    const result = maskProfanity("you are a bitch");
    expect(result.masked).toBe(true);
    expect(result.text).toBe("you are a *****");
  });

  it("is case-insensitive", async () => {
    const { maskProfanity } = await import("@src/domains/chat/profanity.js");
    const result = maskProfanity("SHIT happens");
    expect(result.masked).toBe(true);
    expect(result.text).toBe("**** happens");
  });

  it("tolerates leetspeak substitutions", async () => {
    const { maskProfanity } = await import("@src/domains/chat/profanity.js");
    const result = maskProfanity("you are a $h1t idiot");
    expect(result.masked).toBe(true);
    // Length of the masked span matches the matched leet text, not the
    // canonical word.
    expect(result.text).toMatch(/^you are a \*+ idiot$/);
    expect(result.text).not.toMatch(/\$h1t/i);
  });

  it("tolerates repeated letters", async () => {
    const { maskProfanity } = await import("@src/domains/chat/profanity.js");
    const result = maskProfanity("fuuuuck you");
    expect(result.masked).toBe(true);
    expect(result.text.startsWith("*")).toBe(true);
    expect(result.text.endsWith(" you")).toBe(true);
  });

  it("only matches whole words, not substrings", async () => {
    const { maskProfanity } = await import("@src/domains/chat/profanity.js");
    expect(maskProfanity("this class is great")).toEqual({
      text: "this class is great",
      masked: false,
    });
    expect(maskProfanity("please assist me")).toEqual({
      text: "please assist me",
      masked: false,
    });
    expect(maskProfanity("I visited Scunthorpe last year")).toEqual({
      text: "I visited Scunthorpe last year",
      masked: false,
    });
  });

  it("preserves the overall text length when masking", async () => {
    const { maskProfanity } = await import("@src/domains/chat/profanity.js");
    const input = "what the fuck is going on";
    const result = maskProfanity(input);
    expect(result.text.length).toBe(input.length);
  });

  it("replaces the matched word with asterisks equal to its own length", async () => {
    const { maskProfanity } = await import("@src/domains/chat/profanity.js");
    const result = maskProfanity("shit");
    expect(result.text).toBe("****");
  });
});

describe("maskProfanity with CHAT_BLOCKED_WORDS env override", () => {
  const ORIGINAL = process.env.CHAT_BLOCKED_WORDS;

  beforeAll(() => {
    process.env.CHAT_BLOCKED_WORDS = "floob,zibberwock";
  });

  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.CHAT_BLOCKED_WORDS;
    else process.env.CHAT_BLOCKED_WORDS = ORIGINAL;
  });

  it("merges extra words from env at module load", async () => {
    // Fresh module graph so the env var above is read at load time.
    vi.resetModules();
    const { maskProfanity } = await import("@src/domains/chat/profanity.js");
    const result = maskProfanity("that is a floob thing to say");
    expect(result.masked).toBe(true);
    expect(result.text).toBe("that is a ***** thing to say");
  });
});
