/**
 * Wraps an observer so that its own bug can never reach the host. An uncaught throw in a hook fails the session's run
 * ("Failed to drain Session"), and this plugin only watches sessions, so it must never be the cause of that.
 * Reports once per distinct error class to keep a repeating fault from flooding the log.
 */
export function failOpen<Args extends ReadonlyArray<unknown>>(
  name: string,
  observe: (...args: Args) => void,
  report: (message: string) => void,
): (...args: Args) => void {
  const reported = new Set<string>();
  return (...args) => {
    try {
      observe(...args);
    } catch (error) {
      const kind = error instanceof Error ? error.name : "unknown";
      if (reported.has(kind)) return;
      reported.add(kind);
      report(`${name} failed (${kind}); the session was not affected`);
    }
  };
}
