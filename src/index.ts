import { Plugin } from "@opencode/plugin";
import { createIdleCompactor } from "./compactor";
import { parseConfig } from "./config";
import { isWarmingPing } from "./warming";

export default Plugin.define({
  id: "opencode-autocompact",
  async setup(ctx) {
    const config = parseConfig(ctx.options);
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
          // Hooks are location-scoped today, so only the owning instance has state. This check keeps a second
          // instance from compacting someone else's session should that ever stop being true.
          if (info.location.directory !== ctx.location.directory) return false;
          return config.includeSubagents || info.parentID === undefined;
        },
        // Queue rather than steer: an idle session runs the compaction now, and a racing user message is never injected mid-run.
        compact: async sessionID => {
          await ctx.session.compact({ sessionID, delivery: "queue" });
        },
        report: message => console.warn(`opencode-autocompact: ${message}`),
        announce: (sessionID, idleMs) =>
          console.warn(`opencode-autocompact: compacting ${sessionID} after ${Math.round(idleMs / 1000)}s idle in ${ctx.location.directory}`),
      },
    );

    // These hooks reach only the instance that owns the session's location, which is what makes them proof of ownership.
    const promptHook = await ctx.session.hook("prompt", event => {
      compactor.userPrompted(event.sessionID);
    });
    const contextHook = await ctx.session.hook("context", event => {
      compactor.modelCalled(event.sessionID);
    });
    const compactionHook = await ctx.session.hook("compaction", event => {
      compactor.compactionRequested(event.sessionID);
    });
    // Observe only: the keep-alive request is answered normally; this hook never alters it.
    const warmingHook = await ctx.session.hook("generate", event => {
      if (isWarmingPing(event.messages, config.warmingPrompt)) compactor.warmingPinged(event.sessionID);
    });

    const subscription = new AbortController();
    const observing = (async () => {
      for await (const event of ctx.event.subscribe({ signal: subscription.signal })) {
        switch (event.type) {
          case "session.execution.started":
            compactor.executionStarted(event.data.sessionID);
            break;
          case "session.execution.succeeded":
          case "session.execution.failed":
          case "session.execution.interrupted":
            compactor.executionSettled(event.data.sessionID);
            break;
          case "session.deleted":
            compactor.forget(event.data.sessionID);
            break;
        }
      }
    })().catch(() => {
      if (!subscription.signal.aborted) {
        console.warn("opencode-autocompact: event subscription ended; automatic idle compaction is inactive");
      }
    });

    return async () => {
      subscription.abort();
      compactor.dispose();
      await promptHook.dispose();
      await contextHook.dispose();
      await compactionHook.dispose();
      await warmingHook.dispose();
      await observing;
    };
  },
});
