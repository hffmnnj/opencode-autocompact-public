/** Default idle window: just under the 5-minute prompt-cache lifetime, so compaction is dispatched while the cache is still warm. */
export const DEFAULT_IDLE_SECONDS = 290;
/** Anthropic's default prompt-cache lifetime. Set to 3600 for accounts on the 1-hour tier. */
export const DEFAULT_CACHE_TTL_SECONDS = 300;

/** Must match the native `opencode.warming` default, or a customised warming prompt must be set here too. */
export const DEFAULT_WARMING_PROMPT =
  "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK";

export interface AutoCompactConfig {
  readonly idleSeconds: number;
  readonly cacheTtlSeconds: number;
  readonly includeSubagents: boolean;
  readonly warmingPrompt: string;
}

const KNOWN_KEYS = new Set(["idleSeconds", "cacheTtlSeconds", "includeSubagents", "warmingPrompt"]);

function positiveInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`opencode-autocompact: ${name} must be a positive integer`);
  }
  return value;
}

/** Strict on purpose: an unknown key is almost always a typo that would otherwise silently keep the default. */
export function parseConfig(raw: unknown): AutoCompactConfig {
  if (raw === undefined) return parseConfig({});
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("opencode-autocompact: options must be an object");
  }
  const unknown = Object.keys(raw).filter(key => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`opencode-autocompact: unknown option(s): ${unknown.join(", ")}`);
  }
  const { idleSeconds, cacheTtlSeconds, includeSubagents, warmingPrompt } = raw as Record<string, unknown>;
  if (includeSubagents !== undefined && typeof includeSubagents !== "boolean") {
    throw new Error("opencode-autocompact: includeSubagents must be a boolean");
  }
  if (warmingPrompt !== undefined && (typeof warmingPrompt !== "string" || warmingPrompt.length === 0)) {
    throw new Error("opencode-autocompact: warmingPrompt must be a non-empty string");
  }
  const config: AutoCompactConfig = {
    idleSeconds: positiveInteger(idleSeconds, "idleSeconds", DEFAULT_IDLE_SECONDS),
    cacheTtlSeconds: positiveInteger(cacheTtlSeconds, "cacheTtlSeconds", DEFAULT_CACHE_TTL_SECONDS),
    includeSubagents: includeSubagents ?? false,
    warmingPrompt: warmingPrompt ?? DEFAULT_WARMING_PROMPT,
  };
  // Compaction must be dispatched before the cache expires; an idle window at or past the TTL can never fire warm.
  if (config.idleSeconds >= config.cacheTtlSeconds) {
    throw new Error("opencode-autocompact: idleSeconds must be less than cacheTtlSeconds");
  }
  return config;
}
