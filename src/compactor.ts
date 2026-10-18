export interface CompactorOptions {
  readonly idleMs: number;
  readonly cacheTtlMs: number;
  readonly includeSubagents: boolean;
}

export interface CompactorDeps {
  readonly now: () => number;
  /** Returns a cancel function. */
  readonly schedule: (run: () => void, delayMs: number) => () => void;
  readonly isEligible: (sessionID: string) => Promise<boolean>;
  readonly compact: (sessionID: string) => Promise<void>;
  /** Failures only; never include conversation content. */
  readonly report: (message: string) => void;
  /** Every automatic compaction is announced, so an unexpected one can be traced to this plugin. */
  readonly announce: (sessionID: string, idleMs: number) => void;
}

/**
 * Session events are delivered to every plugin instance, but hooks only reach the instance whose location owns the
 * session. A keep-alive is therefore visible only to the owner. State is created solely from owner-scoped signals
 * (`userPrompted`, `modelCalled`); every event-driven method ignores sessions it has no state for. Without that rule,
 * each other instance counts down on its own, never hears a keep-alive, and compacts a still-warming session.
 */
export interface IdleCompactor {
  /** A model call seen through a hook, so this instance owns the session and it is running now. */
  modelCalled(sessionID: string): void;
  /** A compaction request by anyone (manual or automatic): this stretch has had its compaction. */
  compactionRequested(sessionID: string): void;
  executionStarted(sessionID: string): void;
  executionSettled(sessionID: string): void;
  /** A keep-alive ping: the countdown restarts from here, so compaction waits until warming stops. */
  warmingPinged(sessionID: string): void;
  userPrompted(sessionID: string): void;
  forget(sessionID: string): void;
  dispose(): void;
}

/** One idle stretch: from a settled run until the next user prompt or execution. */
interface Stretch {
  busy: boolean;
  /** At most one automatic compaction per stretch, so our own compaction cannot re-arm the next one. */
  compacted: boolean;
  /** Bumped on every transition; a callback scheduled or started under an older value is stale. */
  generation: number;
  cancel?: () => void;
}

export function createIdleCompactor(options: CompactorOptions, deps: CompactorDeps): IdleCompactor {
  const stretches = new Map<string, Stretch>();
  let disposed = false;

  const stretchFor = (sessionID: string): Stretch => {
    const existing = stretches.get(sessionID);
    if (existing) return existing;
    const created: Stretch = { busy: false, compacted: false, generation: 0 };
    stretches.set(sessionID, created);
    return created;
  };

  const disarm = (stretch: Stretch): void => {
    stretch.generation++;
    stretch.cancel?.();
    stretch.cancel = undefined;
  };

  const arm = (sessionID: string, stretch: Stretch): void => {
    disarm(stretch);
    const generation = stretch.generation;
    const armedAt = deps.now();

    const tick = (): void => {
      stretch.cancel = undefined;
      if (disposed || stretch.generation !== generation) return;

      const elapsed = deps.now() - armedAt;
      if (elapsed < options.idleMs) {
        stretch.cancel = deps.schedule(tick, options.idleMs - elapsed);
        return;
      }
      // A late wake (for example after laptop sleep) means the cache has already expired. Compacting cold
      // re-reads the full history and then pays for the summary as well, which costs more than it saves.
      if (elapsed >= options.cacheTtlMs) return;

      stretch.compacted = true;
      void compactIdle(sessionID, generation, stretch, elapsed);
    };

    stretch.cancel = deps.schedule(tick, options.idleMs);
  };

  const compactIdle = async (sessionID: string, generation: number, stretch: Stretch, idleMs: number): Promise<void> => {
    try {
      if (!(await deps.isEligible(sessionID))) return;
      // Re-check after the awaited lookup: a prompt or new execution may have arrived in the meantime.
      if (disposed || stretch.generation !== generation || stretch.busy) return;
      deps.announce(sessionID, idleMs);
      await deps.compact(sessionID);
    } catch {
      // Never forward the native error: it can contain conversation content.
      deps.report("idle compaction request failed; the session was left unchanged");
    }
  };

  /** Event-driven methods only touch sessions that an owner-scoped signal already registered. */
  const known = (sessionID: string): Stretch | undefined => stretches.get(sessionID);

  return {
    modelCalled(sessionID) {
      const stretch = stretchFor(sessionID);
      stretch.busy = true;
      disarm(stretch);
    },
    compactionRequested(sessionID) {
      const stretch = known(sessionID);
      if (!stretch) return;
      stretch.compacted = true;
      disarm(stretch);
    },
    executionStarted(sessionID) {
      const stretch = known(sessionID);
      if (!stretch) return;
      stretch.busy = true;
      disarm(stretch);
    },
    executionSettled(sessionID) {
      const stretch = known(sessionID);
      if (!stretch) return;
      stretch.busy = false;
      if (!stretch.compacted && !disposed) arm(sessionID, stretch);
    },
    warmingPinged(sessionID) {
      const stretch = known(sessionID);
      if (!stretch || stretch.busy || stretch.compacted || disposed) return;
      arm(sessionID, stretch);
    },
    userPrompted(sessionID) {
      const stretch = stretchFor(sessionID);
      stretch.compacted = false;
      disarm(stretch);
    },
    forget(sessionID) {
      const stretch = stretches.get(sessionID);
      if (!stretch) return;
      disarm(stretch);
      stretches.delete(sessionID);
    },
    dispose() {
      disposed = true;
      for (const stretch of stretches.values()) disarm(stretch);
      stretches.clear();
    },
  };
}
