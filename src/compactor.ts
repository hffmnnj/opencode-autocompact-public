import type { Trace } from "./trace";

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
  /** Every decision is traced, so an unexpected compaction can be explained from the log. */
  readonly trace: (trace: Trace) => void;
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
  /**
   * Set when this plugin asked for a compaction, cleared when the host's `compaction` hook reports it. That hook runs
   * after `compact()` has already returned (the request is queued), so the flag cannot be tied to the call's lifetime.
   */
  requesting: boolean;
  /** Bumped on every transition; a callback scheduled or started under an older value is stale. */
  generation: number;
  cancel?: () => void;
}

export function createIdleCompactor(options: CompactorOptions, deps: CompactorDeps): IdleCompactor {
  const stretches = new Map<string, Stretch>();
  let disposed = false;

  /** Creates state, which marks this instance as the owner. Only owner-scoped hooks may call this. */
  const own = (sessionID: string, via: "prompt" | "context"): Stretch => {
    const existing = stretches.get(sessionID);
    if (existing) return existing;
    const created: Stretch = { busy: false, compacted: false, requesting: false, generation: 0 };
    stretches.set(sessionID, created);
    deps.trace({ event: "owned", sessionID, via });
    return created;
  };

  const disarm = (sessionID: string, stretch: Stretch, why: Extract<Trace, { event: "disarmed" }>["why"]): void => {
    // Only a countdown that was actually pending is worth a log line.
    if (stretch.cancel) deps.trace({ event: "disarmed", sessionID, why });
    stretch.generation++;
    stretch.cancel?.();
    stretch.cancel = undefined;
  };

  const arm = (sessionID: string, stretch: Stretch, via: "settled" | "keepalive"): void => {
    stretch.generation++;
    stretch.cancel?.();
    const generation = stretch.generation;
    const armedAt = deps.now();
    deps.trace({ event: "armed", sessionID, via, fireInMs: options.idleMs });

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
      if (elapsed >= options.cacheTtlMs) {
        deps.trace({ event: "skipped", sessionID, why: "cache-expired", idleMs: elapsed });
        return;
      }

      stretch.compacted = true;
      void compactIdle(sessionID, generation, stretch, elapsed);
    };

    stretch.cancel = deps.schedule(tick, options.idleMs);
  };

  const compactIdle = async (sessionID: string, generation: number, stretch: Stretch, idleMs: number): Promise<void> => {
    try {
      if (!(await deps.isEligible(sessionID))) {
        deps.trace({ event: "skipped", sessionID, why: "ineligible", idleMs });
        return;
      }
      // Re-check after the awaited lookup: a prompt or new execution may have arrived in the meantime.
      if (disposed || stretch.generation !== generation || stretch.busy) {
        deps.trace({ event: "skipped", sessionID, why: "activity-during-lookup", idleMs });
        return;
      }
      deps.trace({ event: "compacting", sessionID, idleMs });
      stretch.requesting = true;
      await deps.compact(sessionID);
      deps.trace({ event: "compact-result", sessionID, ok: true });
    } catch (error) {
      // Never forward the native error text: it can contain conversation content. The class name is safe.
      stretch.requesting = false;
      deps.trace({ event: "compact-result", sessionID, ok: false, errorName: error instanceof Error ? error.name : "unknown" });
      deps.report("idle compaction request failed; the session was left unchanged");
    }
  };

  /** Event-driven methods only touch sessions that an owner-scoped signal already registered. */
  const known = (sessionID: string): Stretch | undefined => stretches.get(sessionID);

  return {
    modelCalled(sessionID) {
      const stretch = own(sessionID, "context");
      stretch.busy = true;
      disarm(sessionID, stretch, "model-call");
    },
    compactionRequested(sessionID) {
      const stretch = known(sessionID);
      if (!stretch) return;
      deps.trace({ event: "compaction-seen", sessionID, by: stretch.requesting ? "plugin" : "other" });
      stretch.requesting = false;
      stretch.compacted = true;
      disarm(sessionID, stretch, "compaction-seen");
    },
    executionStarted(sessionID) {
      const stretch = known(sessionID);
      if (!stretch) return;
      stretch.busy = true;
      disarm(sessionID, stretch, "execution-started");
    },
    executionSettled(sessionID) {
      const stretch = known(sessionID);
      if (!stretch) return;
      stretch.busy = false;
      if (disposed) return;
      if (stretch.compacted) {
        deps.trace({ event: "settle-ignored", sessionID, why: "already-compacted" });
        return;
      }
      arm(sessionID, stretch, "settled");
    },
    warmingPinged(sessionID) {
      const stretch = known(sessionID);
      if (!stretch || disposed) return;
      if (stretch.busy || stretch.compacted) {
        deps.trace({ event: "keepalive-ignored", sessionID, why: stretch.busy ? "running" : "already-compacted" });
        return;
      }
      arm(sessionID, stretch, "keepalive");
    },
    userPrompted(sessionID) {
      const stretch = own(sessionID, "prompt");
      stretch.compacted = false;
      stretch.requesting = false;
      disarm(sessionID, stretch, "prompt");
    },
    forget(sessionID) {
      const stretch = stretches.get(sessionID);
      if (!stretch) return;
      disarm(sessionID, stretch, "forgotten");
      stretches.delete(sessionID);
    },
    dispose() {
      disposed = true;
      for (const stretch of stretches.values()) {
        stretch.generation++;
        stretch.cancel?.();
        stretch.cancel = undefined;
      }
      stretches.clear();
    },
  };
}
