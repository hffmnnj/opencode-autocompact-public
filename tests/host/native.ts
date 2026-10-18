import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin, Provider, Model } from "@opencode/plugin";
import { OpenCode } from "@opencode/sdk";

// Runs inside an isolated HOME/XDG tree created by run.ts. Real native host, real plugin loader, scripted provider.
const root = process.argv[2]!;
assert(root.startsWith("/tmp/autocompact-host-") && process.env.HOME === join(root, "home"));
const directory = join(root, "workspace");
await mkdir(directory, { recursive: true });

const IDLE_SECONDS = 2;
const CACHE_TTL_SECONDS = 6;
const pluginDirectory = fileURLToPath(new URL("../../", import.meta.url));

type ProviderRequest = { stream?: boolean; messages: Array<{ role: string; content?: unknown }> };
const providerRequests: Array<{ at: number; keepAlive: boolean }> = [];
// The native warming plugin sends its keep-alive prompt as the final message; this is the only trace it leaves.
const KEEP_ALIVE_MARKER = "keep-alive request";
let serial = 0;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
  const body = (await request.json()) as ProviderRequest;
  providerRequests.push({ at: Date.now(), keepAlive: JSON.stringify(body.messages.at(-1)).includes(KEEP_ALIVE_MARKER) });
  const base = { id: `response_${++serial}`, created: 1, model: "fixture" };
  // Compaction rejects summaries without a native template heading, so every scripted reply carries one.
  const reply = "## Objective\nFixture complete";
  if (!body.stream) {
    return Response.json({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }] });
  }
  const chunks = [
    { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] },
    { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    controller.close();
  } });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
} });

const fixture = Plugin.define({ id: "autocompact.fixture", async setup(ctx) {
  await ctx.session.hook("title", event => { event.result = "Autocompact fixture"; });
  const providerID = Provider.ID.make("autocompacttest");
  const model = Model.Info.default(providerID, Model.ID.make("fixture"));
  await ctx.provider.transform(editor => editor.add({
    info: { ...Provider.Info.empty(providerID), activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "synthetic" } },
    models: [{ ...model, capabilities: { ...model.capabilities, tools: true, input: ["text"] }, limit: { context: 32768, output: 4096 } }],
  }));
} });

const host = await OpenCode.create({
  app: { name: "autocompact-tests", version: "0.1.0" }, database: { path: join(root, "host.sqlite") },
  config: { directory: join(root, "config"), project: false, content: JSON.stringify({
    update: "disable", model: "autocompacttest/fixture",
    // Keep-alives must land inside the idle window and stop before the idle timer can fire.
    warming: { interval: "1 second", duration: "4 seconds" },
    plugins: ["*", "-opencode.provider.*", { package: pluginDirectory, options: { idleSeconds: IDLE_SECONDS, cacheTtlSeconds: CACHE_TTL_SECONDS } }],
  }) },
  models: { fetch: false, snapshot: false }, fs: { filewatcher: false, fff: false }, plugins: [fixture],
});

const observed: Array<{ type: string; created: number; data?: { sessionID?: string; reason?: string } }> = [];
const eventsAbort = new AbortController();
const observing = (async () => {
  for await (const event of host.event.subscribe({ signal: eventsAbort.signal })) observed.push(event as typeof observed[number]);
})().catch(() => undefined);

async function waitFor<T>(description: string, read: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(25);
  }
}

const sessionEvents = (sessionID: string, type: string) => observed.filter(event => event.type === type && event.data?.sessionID === sessionID);
const idleCompactions = (sessionID: string) => sessionEvents(sessionID, "session.compaction.ended");

let exitCode = 0;
try {
  const session = await host.session.create({ location: { directory }, agent: "build", model: { providerID: "autocompacttest", id: "fixture" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] });

  const runOnce = async (text: string) => {
    await host.session.prompt({ sessionID: session.id, text });
    await host.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(15_000) });
    return waitFor("settled execution", () => sessionEvents(session.id, "session.execution.succeeded").at(-1), 5_000);
  };

  const settled = await runOnce("first prompt");
  assert.equal(idleCompactions(session.id).length, 0, "No compaction may run before the idle window");

  const firstCompaction = await waitFor("automatic idle compaction", () => idleCompactions(session.id).at(0), (CACHE_TTL_SECONDS + 5) * 1000);
  const keepAlivesBeforeCompaction = providerRequests.filter(request => request.keepAlive && request.at <= firstCompaction.created);
  assert(keepAlivesBeforeCompaction.length >= 2, "Warming must have run before the compaction, or the test proves nothing about it");
  const lastKeepAliveAt = Math.max(...keepAlivesBeforeCompaction.map(request => request.at));
  const idleGapMs = firstCompaction.created - lastKeepAliveAt;
  assert(idleGapMs >= IDLE_SECONDS * 1000 - 150, `Compaction fired before the final keep-alive plus the idle window: ${idleGapMs}ms`);
  assert(idleGapMs < CACHE_TTL_SECONDS * 1000, `Compaction fired at/after cache TTL: ${idleGapMs}ms after the final keep-alive`);
  assert(firstCompaction.created > settled.created, "Compaction must follow the settled run");

  await Bun.sleep((CACHE_TTL_SECONDS + 1) * 1000);
  assert.equal(idleCompactions(session.id).length, 1, "Exactly one automatic compaction per idle stretch");

  const secondRunStarted = providerRequests.length;
  await runOnce("second prompt after idle compaction");
  assert(providerRequests.length > secondRunStarted, "The user prompt must reach the provider");
  await waitFor("second automatic idle compaction after a new prompt", () => (idleCompactions(session.id).length >= 2 ? true : undefined), (CACHE_TTL_SECONDS + 5) * 1000);
  await Bun.sleep((CACHE_TTL_SECONDS + 1) * 1000);
  assert.equal(idleCompactions(session.id).length, 2, "A new user prompt starts exactly one new idle stretch");

  console.log(JSON.stringify({
    nativeEnforcement: "verified",
    idleSeconds: IDLE_SECONDS,
    cacheTtlSeconds: CACHE_TTL_SECONDS,
    keepAlivesBeforeCompaction: keepAlivesBeforeCompaction.length,
    idleGapFromFinalKeepAliveMs: idleGapMs,
    automaticCompactions: idleCompactions(session.id).length,
    compactionReasons: idleCompactions(session.id).map(event => event.data?.reason),
  }));
} catch (error) {
  exitCode = 1;
  const catalog = await host.plugin.list({ location: { directory } }).catch(() => undefined);
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : "unknown failure",
    plugins: catalog?.data.map(plugin => ({ id: plugin.id, status: plugin.state.status })),
    eventTypes: [...new Set(observed.map(event => event.type))],
    compactionFailures: observed.filter(event => event.type === "session.compaction.failed"),
    providerRequests: providerRequests.length,
  }));
} finally {
  eventsAbort.abort();
  await observing;
  await host.close();
  server.stop(true);
}
process.exit(exitCode);
