/**
 * The native warming plugin sends a keep-alive as a generate request whose final message is exactly its prompt.
 * Keep-alives emit no session events, so this request shape is the only signal that warming is still running.
 */
export function isWarmingPing(messages: ReadonlyArray<unknown>, warmingPrompt: string): boolean {
  const last: unknown = messages.at(-1);
  if (typeof last !== "object" || last === null) return false;
  const { role, content } = last as { role?: unknown; content?: unknown };
  if (role !== "user" || !Array.isArray(content) || content.length !== 1) return false;
  const [part] = content as ReadonlyArray<{ type?: unknown; text?: unknown }>;
  return part?.type === "text" && part.text === warmingPrompt;
}
