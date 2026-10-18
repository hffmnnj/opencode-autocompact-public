import { describe, expect, test } from "bun:test";
import { DEFAULT_WARMING_PROMPT, parseConfig } from "../../src/config";

describe("parseConfig defaults", () => {
  test("uses a 290 second idle window inside the 5 minute cache lifetime and excludes subagents", () => {
    expect(parseConfig(undefined)).toEqual({
      idleSeconds: 290,
      cacheTtlSeconds: 300,
      includeSubagents: false,
      warmingPrompt: DEFAULT_WARMING_PROMPT,
    });
  });

  test("accepts a 1 hour cache tier with a longer idle window", () => {
    expect(parseConfig({ idleSeconds: 3300, cacheTtlSeconds: 3600 })).toMatchObject({
      idleSeconds: 3300,
      cacheTtlSeconds: 3600,
    });
  });

  test("takes a customised keep-alive prompt for warming detection", () => {
    expect(parseConfig({ warmingPrompt: "ping" })).toMatchObject({ warmingPrompt: "ping" });
  });
});

describe("parseConfig keep-alive prompt", () => {
  test("rejects an empty warming prompt, which would match nothing useful", () => {
    expect(() => parseConfig({ warmingPrompt: "" })).toThrow("warmingPrompt must be a non-empty string");
  });
});

describe("parseConfig rejects unsafe or ambiguous options", () => {
  test("rejects an unknown key so a typo cannot silently keep the default", () => {
    expect(() => parseConfig({ idleSecond: 120 })).toThrow("unknown option(s): idleSecond");
  });

  test("rejects an idle window at or beyond the cache lifetime, which could never fire warm", () => {
    expect(() => parseConfig({ idleSeconds: 300, cacheTtlSeconds: 300 })).toThrow(
      "idleSeconds must be less than cacheTtlSeconds",
    );
    expect(() => parseConfig({ idleSeconds: 400 })).toThrow("idleSeconds must be less than cacheTtlSeconds");
  });

  test.each([0, -1, 1.5, Number.NaN, "290"])("rejects a non-positive-integer idleSeconds (%p)", value => {
    expect(() => parseConfig({ idleSeconds: value })).toThrow("idleSeconds must be a positive integer");
  });

  test("rejects a non-boolean includeSubagents rather than coercing it", () => {
    expect(() => parseConfig({ includeSubagents: "yes" })).toThrow("includeSubagents must be a boolean");
  });

  test("rejects options that are not an object", () => {
    expect(() => parseConfig(["290"])).toThrow("options must be an object");
  });
});
