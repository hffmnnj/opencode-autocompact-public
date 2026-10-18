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
          if (config.includeSubagents) return true;
          const info = await ctx.session.get({ sessionID });
          return info.parentID === undefined;
        },
        // Queue rather than steer: an idle session runs the compaction now, and a racing user message is never injected mid-run.
        compact: async sessionID => {
          await ctx.session.compact({ sessionID, delivery: "queue" });
        },
        report: message => console.warn(`opencode-autocompact: ${message}`),
      },
    );

    const promptHook = await ctx.session.hook("prompt", event => {
      compactor.userPrompted(event.sessionID);
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
      await warmingHook.dispose();
      await observing;
    };
  },
});
