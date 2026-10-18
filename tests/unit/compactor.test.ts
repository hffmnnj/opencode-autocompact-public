import { describe, expect, test } from "bun:test";
import { createIdleCompactor, type CompactorDeps, type CompactorOptions } from "../../src/compactor";

const SECOND = 1_000;
const OPTIONS: CompactorOptions = { idleMs: 290 * SECOND, cacheTtlMs: 300 * SECOND, includeSubagents: false };
const SESSION = "ses_primary";

type ScheduledRun = { readonly dueAt: number; readonly run: () => void; cancelled: boolean };

/** Deterministic clock: timers run only when the test advances or jumps time. */
function harness(overrides: Partial<CompactorDeps> = {}) {
  let clock = 0;
  const scheduled: ScheduledRun[] = [];
  const compacted: string[] = [];
  const reports: string[] = [];

  const deps: CompactorDeps = {
    now: () => clock,
    schedule: (run, delayMs) => {
      const entry: ScheduledRun = { dueAt: clock + delayMs, run, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    isEligible: async () => true,
    compact: async sessionID => {
      compacted.push(sessionID);
    },
    report: message => {
      reports.push(message);
    },
    ...overrides,
  };
  const compactor = createIdleCompactor(OPTIONS, deps);

  /** Let pending promise continuations (eligibility lookup, compaction request) settle. */
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  };

  const runDueTimers = async (until: number): Promise<void> => {
    for (;;) {
      const next = scheduled
        .filter(entry => !entry.cancelled && entry.dueAt <= until)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!next) break;
      next.cancelled = true;
      clock = Math.max(clock, next.dueAt);
      next.run();
      await settle();
    }
  };

  return {
    compactor,
    compacted,
    reports,
    advanceTo: async (ms: number) => {
      await runDueTimers(ms);
      clock = ms;
      await settle();
    },
    /** Models a process that was suspended: the wall clock jumps and only then are overdue timers observed. */
    wakeAt: async (ms: number) => {
      clock = ms;
      await runDueTimers(ms);
      await settle();
    },
    now: () => clock,
  };
}

describe("idle compaction timing", () => {
  test("compacts exactly at the 290 second idle window after a settled run", async () => {
    const h = harness();
    h.compactor.executionStarted(SESSION);
    h.compactor.executionSettled(SESSION);

    await h.advanceTo(290 * SECOND - 1);
    expect(h.compacted).toEqual([]);

    await h.advanceTo(290 * SECOND);
    expect(h.compacted).toEqual([SESSION]);
  });

  test("never compacts while an execution is running, however long it runs", async () => {
    const h = harness();
    h.compactor.executionStarted(SESSION);

    await h.advanceTo(1000 * SECOND);
    expect(h.compacted).toEqual([]);

    h.compactor.executionStarted(SESSION);
    h.compactor.executionSettled(SESSION);
    await h.advanceTo(1000 * SECOND + 290 * SECOND);
    expect(h.compacted).toEqual([SESSION]);
  });

  test("a user prompt during the idle window cancels the pending compaction", async () => {
    const h = harness();
    h.compactor.executionStarted(SESSION);
    h.compactor.executionSettled(SESSION);

    await h.advanceTo(100 * SECOND);
    h.compactor.userPrompted(SESSION);

    await h.advanceTo(290 * SECOND);
    expect(h.compacted).toEqual([]);
  });

  test("the idle window restarts from the next settled run, not from the earlier prompt", async () => {
    const h = harness();
    h.compactor.executionStarted(SESSION);
    h.compactor.executionSettled(SESSION);
    await h.advanceTo(100 * SECOND);
    h.compactor.userPrompted(SESSION);
    h.compactor.executionStarted(SESSION);
    await h.advanceTo(200 * SECOND);
    h.compactor.executionStarted(SESSION);
    h.compactor.executionSettled(SESSION);

    await h.advanceTo(200 * SECOND + 289 * SECOND);
    expect(h.compacted).toEqual([]);

    await h.advanceTo(200 * SECOND + 290 * SECOND);
    expect(h.compacted).toEqual([SESSION]);
  });
});

describe("idle stretch guarantees", () => {
  test("compacts at most once per idle stretch, even though its own run settles again", async () => {
    const h = harness();
    h.compactor.executionStarted(SESSION);
    h.compactor.executionSettled(SESSION);
    await h.advanceTo(290 * SECOND);
    expect(h.compacted).toEqual([SESSION]);

    // The automatic compaction is itself an execution; its settlement must not start a second countdown.
    h.compactor.executionStarted(SESSION);
    h.compactor.executionStarted(SESSION);
    h.compactor.executionSettled(SESSION);
    await h.advanceTo(290 * SECOND + 10_000 * SECOND);
    expect(h.compacted).toEqual([SESSION]);
  });

  test("a new user prompt starts a fresh stretch that can compact again", async () => {
    const h = harness();
    h.compactor.executionStarted(SESSION);
    h.compactor.executionSettled(SESSION);
    await h.advanceTo(290 * SECOND);

    h.compactor.userPrompted(SESSION);
    h.compactor.executionStarted(SESSION);
    h.compactor.executionStarted(SESSION);
    h.compactor.executionSettled(SESSION);
    const settledAt = h.now();
    await h.advanceTo(settledAt + 290 * SECOND);
    expect(h.compacted).toEqual([SESSION, SESSION]);
  });

  test("a failed compaction request is not retried within the same stretch", async () => {
    const h = harness({
      compact: async () => {
        throw new Error("provider transcript: secret user text");
      },
    });
    h.compactor.executionStarted(SESSION);
    h.compactor.executionSettled(SESSION);
    await h.advanceTo(290 * SECOND);
    await h.advanceTo(2000 * SECOND);

    expect(h.reports).toEqual(["idle compaction request failed; the session was left unchanged"]);
    expect(h.reports.join("\n")).not.toContain("secret user text");
  });
});

describe("cache-expiry safety", () => {
  test("does not compact cold when the timer wakes after the cache TTL has already passed", async () => {
    const h = harness();
    h.compactor.executionStarted(SESSION);
    h.compactor.executionSettled(SESSION);

    // Suspended machine: the timer is overdue and the cache has expired by the time it runs.
    await h.wakeAt(310 * SECOND);
    expect(h.compacted).toEqual([]);
  });

  test("still compacts when the timer fires late but inside the warm window", async () => {
    const h = harness();
    h.compactor.executionStarted(SESSION);
    h.compactor.executionSettled(SESSION);

    await h.wakeAt(295 * SECOND);
    expect(h.compacted).toEqual([SESSION]);
  });
});

describe("eligibility and lifecycle", () => {
  test("does not compact sessions the policy excludes, such as subagents", async () => {
    const h = harness({ isEligible: async () => false });
    h.compactor.executionStarted("ses_child");
    h.compactor.executionSettled("ses_child");

    await h.advanceTo(290 * SECOND);
    expect(h.compacted).toEqual([]);
  });

  test("abandons a compaction when activity arrives while the eligibility lookup is pending", async () => {
    let releaseLookup: (eligible: boolean) => void = () => undefined;
    const pendingLookup = new Promise<boolean>(resolve => {
      releaseLookup = resolve;
    });
    const h = harness({ isEligible: () => pendingLookup });
    h.compactor.executionStarted(SESSION);
    h.compactor.executionSettled(SESSION);

    await h.advanceTo(290 * SECOND);
    h.compactor.userPrompted(SESSION);
    releaseLookup(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.compacted).toEqual([]);
  });

  test("dispose cancels every pending compaction", async () => {
    const h = harness();
    h.compactor.executionStarted(SESSION);
    h.compactor.executionSettled(SESSION);

    h.compactor.dispose();
    await h.advanceTo(290 * SECOND);
    expect(h.compacted).toEqual([]);
  });

  test("forgetting a deleted session cancels its pending compaction", async () => {
    const h = harness();
    h.compactor.executionStarted(SESSION);
    h.compactor.executionSettled(SESSION);

    h.compactor.forget(SESSION);
    await h.advanceTo(290 * SECOND);
    expect(h.compacted).toEqual([]);
  });
});

describe("warming keep-alives", () => {
  test("compacts 290 seconds after the final keep-alive, not after the settled run", async () => {
    const h = harness();
    h.compactor.executionStarted(SESSION);
    h.compactor.executionSettled(SESSION);

    await h.advanceTo(240 * SECOND);
    h.compactor.warmingPinged(SESSION);
    await h.advanceTo(480 * SECOND);
    h.compactor.warmingPinged(SESSION);

    await h.advanceTo(480 * SECOND + 289 * SECOND);
    expect(h.compacted).toEqual([]);

    await h.advanceTo(480 * SECOND + 290 * SECOND);
    expect(h.compacted).toEqual([SESSION]);
  });

  test("a keep-alive while the session is running neither starts nor restarts a countdown", async () => {
    const h = harness();
    h.compactor.executionStarted(SESSION);
    await h.advanceTo(100 * SECOND);
    h.compactor.warmingPinged(SESSION);

    await h.advanceTo(10_000 * SECOND);
    expect(h.compacted).toEqual([]);

    h.compactor.executionStarted(SESSION);
    h.compactor.executionSettled(SESSION);
    await h.advanceTo(10_000 * SECOND + 290 * SECOND);
    expect(h.compacted).toEqual([SESSION]);
  });

  test("a keep-alive after the automatic compaction does not start another countdown", async () => {
    const h = harness();
    h.compactor.executionStarted(SESSION);
    h.compactor.executionSettled(SESSION);
    await h.advanceTo(290 * SECOND);
    expect(h.compacted).toEqual([SESSION]);

    h.compactor.warmingPinged(SESSION);
    await h.advanceTo(290 * SECOND + 1000 * SECOND);
    expect(h.compacted).toEqual([SESSION]);
  });

  test("a keep-alive for a session with no observed activity does not start a countdown", async () => {
    const h = harness();
    h.compactor.warmingPinged(SESSION);

    await h.advanceTo(290 * SECOND);
    expect(h.compacted).toEqual([]);
  });
});

describe("only sessions active under observation", () => {
  test("a run that settles without an observed start (began before load) is never compacted", async () => {
    const h = harness();
    h.compactor.executionSettled(SESSION);

    await h.advanceTo(10_000 * SECOND);
    expect(h.compacted).toEqual([]);
  });

  test("keep-alives alone do not make an untouched old session eligible", async () => {
    const h = harness();
    h.compactor.warmingPinged(SESSION);
    await h.advanceTo(240 * SECOND);
    h.compactor.warmingPinged(SESSION);

    await h.advanceTo(10_000 * SECOND);
    expect(h.compacted).toEqual([]);
  });

  test("a user prompt counts as observed activity, so the session becomes eligible once it settles", async () => {
    const h = harness();
    h.compactor.userPrompted(SESSION);
    h.compactor.executionSettled(SESSION);

    await h.advanceTo(290 * SECOND);
    expect(h.compacted).toEqual([SESSION]);
  });
});
