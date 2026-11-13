import { Plugin } from "@opencode/plugin";
import { createIdleCompactor } from "./compactor";
import { parseConfig } from "./config";
import { createDecisionLog, defaultLogPath } from "./log";
import { failOpen } from "./safe";
import { isWarmingPing } from "./warming";

export default Plugin.define({
  id: "hffmnnj.autocompact",
  async setup(ctx) {
    const config = parseConfig(ctx.options);
    const warn = (message: string): void => console.warn(`opencode-autocompact: ${message}`);
    const log =
      config.logFile === false
        ? undefined
        : createDecisionLog(
            config.logFile ?? defaultLogPath(),
            { instance: ctx.location.directory, now: () => Date.now(), pid: process.pid },
            warn,
          );
    const compactor = createIdleCompactor(
      {
        idleMs: config.idleSeconds * 1000,
        cacheTtlMs: config.cacheTtlSeconds * 1000,
        includeSubagents: config.includeSubagents,
      },
      {
        now: () => Date.now(),
        schedule: (run, delayMs) => {
          const timer = setTimeout(run, delayMs);
          return () => clearTimeout(timer);
        },
        isEligible: async sessionID => {
          const info = await ctx.session.get({ sessionID });
          // Official OpenAI models now retain their prompt cache without this idle compaction.
          if (info.model?.providerID === "openai") return false;
          // Hooks are location-scoped today, so only the owning instance has state. This check keeps a second
          // instance from compacting someone else's session should that ever stop being true.
          if (info.location.directory !== ctx.location.directory) return false;
          return config.includeSubagents || info.parentID === undefined;
        },
        // Queue rather than steer: an idle session runs the compaction now, and a racing user message is never injected mid-run.
        compact: async sessionID => {
          await ctx.session.compact({ sessionID, delivery: "queue" });
        },
        report: warn,
        trace: trace => {
          log?.sink(trace);
          if (trace.event === "compacting") {
            warn(`compacting ${trace.sessionID} after ${Math.round(trace.idleMs / 1000)}s idle in ${ctx.location.directory}`);
          }
        },
      },
    );

    // These hooks reach only the instance that owns the session's location, which is what makes them proof of ownership.
    // Every observer is wrapped: a bug here must never fail the session it is watching.
    const promptHook = await ctx.session.hook("prompt", failOpen("prompt hook", event => {
      compactor.userPrompted(event.sessionID);
    }, warn));
    const contextHook = await ctx.session.hook("context", failOpen("context hook", event => {
      compactor.modelCalled(event.sessionID);
    }, warn));
    const compactionHook = await ctx.session.hook("compaction", failOpen("compaction hook", event => {
      compactor.compactionRequested(event.sessionID);
    }, warn));
    // Observe only: the keep-alive request is answered normally; this hook never alters it.
    const warmingHook = await ctx.session.hook("generate", failOpen("generate hook", event => {
      if (isWarmingPing(event.messages, config.warmingPrompt)) compactor.warmingPinged(event.sessionID);
    }, warn));

    const subscription = new AbortController();
    // One bad event is reported and skipped; it must not end the subscription.
    const onEvent = failOpen("event handler", (event: { type: string; data?: unknown }) => {
      const sessionID = (event.data as { sessionID?: string } | undefined)?.sessionID;
      if (sessionID === undefined) return;
      switch (event.type) {
        case "session.execution.started":
          compactor.executionStarted(sessionID);
          break;
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          compactor.executionSettled(sessionID);
          break;
        case "session.deleted":
          compactor.forget(sessionID);
          break;
      }
    }, warn);
    const observing = (async () => {
      for await (const event of ctx.event.subscribe({ signal: subscription.signal })) onEvent(event);
    })().catch(() => {
      if (!subscription.signal.aborted) {
        console.warn("opencode-autocompact: event subscription ended; automatic idle compaction is inactive");
      }
    });

    log?.sink({ event: "loaded", idleSeconds: config.idleSeconds, cacheTtlSeconds: config.cacheTtlSeconds, includeSubagents: config.includeSubagents });
    return async () => {
      subscription.abort();
      compactor.dispose();
      await promptHook.dispose();
      await contextHook.dispose();
      await compactionHook.dispose();
      await warmingHook.dispose();
      await observing;
      log?.sink({ event: "disposed" });
      await log?.flush();
    };
  },
});
