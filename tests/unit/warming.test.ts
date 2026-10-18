import { describe, expect, test } from "bun:test";
import { DEFAULT_WARMING_PROMPT } from "../../src/config";
import { isWarmingPing } from "../../src/warming";

const keepAlive = {
  role: "user",
  content: [{ type: "text", text: DEFAULT_WARMING_PROMPT }],
};

describe("isWarmingPing", () => {
  test("recognises a generate request whose final message is the native keep-alive prompt", () => {
    expect(isWarmingPing([{ role: "user", content: [{ type: "text", text: "earlier" }] }, keepAlive], DEFAULT_WARMING_PROMPT)).toBe(true);
  });

  test("does not treat a user's own message as warming, even when it merely mentions keep-alive", () => {
    const userText = { role: "user", content: [{ type: "text", text: "is this a keep-alive request?" }] };
    expect(isWarmingPing([userText], DEFAULT_WARMING_PROMPT)).toBe(false);
  });

  test("does not match when the final message is an assistant reply that echoes the prompt", () => {
    const echo = { role: "assistant", content: [{ type: "text", text: DEFAULT_WARMING_PROMPT }] };
    expect(isWarmingPing([keepAlive, echo], DEFAULT_WARMING_PROMPT)).toBe(false);
  });

  test("does not match a keep-alive that carries extra parts, which a user message could add", () => {
    const withImage = { role: "user", content: [{ type: "text", text: DEFAULT_WARMING_PROMPT }, { type: "image" }] };
    expect(isWarmingPing([withImage], DEFAULT_WARMING_PROMPT)).toBe(false);
  });

  test("requires the configured prompt, so a customised warming prompt must be set in the plugin options", () => {
    expect(isWarmingPing([keepAlive], "custom ping")).toBe(false);
    expect(isWarmingPing([{ role: "user", content: [{ type: "text", text: "custom ping" }] }], "custom ping")).toBe(true);
  });

  test("returns false for an empty context", () => {
    expect(isWarmingPing([], DEFAULT_WARMING_PROMPT)).toBe(false);
  });
});
