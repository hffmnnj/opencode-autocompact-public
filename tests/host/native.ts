import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin, Provider, Model } from "@opencode/plugin";
import { OpenCode } from "@opencode/sdk";

// Runs inside an isolated HOME/XDG tree created by run.ts. Real native host, real plugin loader, scripted provider.
const root = process.argv[2]!;
const temporary = process.argv[3]!;
assert(root === resolve(root) && dirname(root) === resolve(temporary) && root.startsWith(join(temporary, "autocompact-host-")) && process.env.TMPDIR === root && process.env.HOME === join(root, "home"));
// Two locations: the plugin loads one instance per location, and events reach every instance while hooks do not.
const directory = join(root, "workspace");
const otherDirectory = join(root, "workspace-other");
await mkdir(directory, { recursive: true });
await mkdir(otherDirectory, { recursive: true });

const IDLE_SECONDS = 2;
const CACHE_TTL_SECONDS = 6;
const pluginDirectory = fileURLToPath(new URL("../../", import.meta.url));

type ProviderRequest = { stream?: boolean; messages: Array<{ role: string; content?: unknown }> };
const providerRequests: Array<{ at: number; keepAlive: boolean; tag: string }> = [];
// The native warming plugin sends its keep-alive prompt as the final message; this is the only trace it leaves.
const KEEP_ALIVE_MARKER = "keep-alive request";
let serial = 0;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
  const body = (await request.json()) as ProviderRequest;
  // Every prompt carries a "[tag:X]" marker; the history it leaves in later requests says which session a request belongs to.
  const tag = /\[tag:([a-z-]+)\]/.exec(JSON.stringify(body.messages))?.[1] ?? "none";
  providerRequests.push({ at: Date.now(), keepAlive: JSON.stringify(body.messages.at(-1)).includes(KEEP_ALIVE_MARKER), tag });
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

// Same database across both phases, so the "old" session really exists when the plugin loads.
const databasePath = join(root, "host.sqlite");
const decisionLogPath = join(root, "decisions.jsonl");
const createHost = (withPlugin: boolean) => OpenCode.create({
  app: { name: "autocompact-tests", version: "0.1.0" }, database: { path: databasePath },
  config: { directory: join(root, "config"), project: false, content: JSON.stringify({
    update: "disable", model: "autocompacttest/fixture",
    // Keep-alives must land inside the idle window and stop before the idle timer can fire.
    warming: { interval: "1 second", duration: "4 seconds" },
    plugins: ["*", "-opencode.provider.*", ...(withPlugin ? [{ package: pluginDirectory, options: { idleSeconds: IDLE_SECONDS, cacheTtlSeconds: CACHE_TTL_SECONDS, logFile: decisionLogPath } }] : [])],
  }) },
  models: { fetch: false, snapshot: false }, fs: { filewatcher: false, fff: false }, plugins: [fixture],
});

// The plugin runs in this process, so its announcements show every compaction it decided on, including ones the host
// would turn into no-ops (a second compaction of an already-compacted session leaves no event behind).
const announcements: string[] = [];
const forwardWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  announcements.push(args.join(" "));
  forwardWarn(...args);
};
const announcedFor = (sessionID: string) => announcements.filter(line => line.includes(`compacting ${sessionID} `)).length;

const observed: Array<{ type: string; created: number; data?: { sessionID?: string; reason?: string } }> = [];
async function waitFor<T>(description: string, read: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(25);
  }
}
/** Each host needs its own subscription: runOnce waits on events from whichever host it drives. */
function observe(host: Awaited<ReturnType<typeof createHost>>) {
  const abort = new AbortController();
  const done = (async () => {
    for await (const event of host.event.subscribe({ signal: abort.signal })) observed.push(event as typeof observed[number]);
  })().catch(() => undefined);
  return async () => {
    abort.abort();
    await done;
  };
}
const sessionEvents = (sessionID: string, type: string) => observed.filter(event => event.type === type && event.data?.sessionID === sessionID);
const idleCompactions = (sessionID: string) => sessionEvents(sessionID, "session.compaction.ended");
const runOnce = async (host: Awaited<ReturnType<typeof createHost>>, sessionID: string, text: string) => {
  await host.session.prompt({ sessionID, text });
  await host.session.wait({ sessionID }, { signal: AbortSignal.timeout(15_000) });
  return waitFor("settled execution", () => sessionEvents(sessionID, "session.execution.succeeded").at(-1), 5_000);
};

let exitCode = 0;
let host: Awaited<ReturnType<typeof createHost>> | undefined;
let stopObserving: (() => Promise<void>) | undefined;
try {
  // Phase 1: a chat that runs before the plugin exists, like a session carried over from before a reload.
  const preload = await createHost(false);
  const stopPreloadObserving = observe(preload);
  const oldSession = await preload.session.create({ location: { directory }, agent: "build", model: { providerID: "autocompacttest", id: "fixture" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
  await runOnce(preload, oldSession.id, "written before the plugin loaded [tag:old]");
  await stopPreloadObserving();
  await preload.close();

  // Phase 2: plugin loads; the old chat must stay untouched through a full idle window plus TTL.
  host = await createHost(true);
  stopObserving = observe(host);
  await Bun.sleep((CACHE_TTL_SECONDS + IDLE_SECONDS) * 1000);
  assert.equal(idleCompactions(oldSession.id).length, 0, "A chat idle before the plugin loaded must never be compacted");
  assert.equal(providerRequests.filter(request => request.keepAlive).length, 0, "No keep-alive may be sent for the untouched old chat");

  const newSession = (where: string) =>
    host!.session.create({ location: { directory: where }, agent: "build", model: { providerID: "autocompacttest", id: "fixture" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
  const session = await newSession(directory);
  const other = await newSession(otherDirectory);
  // Run back to back so each location's plugin instance also hears the other session's execution events.
  const settled = await runOnce(host, session.id, "first prompt [tag:main]");
  const otherSettled = await runOnce(host, other.id, "first prompt [tag:other]");
  assert.equal(idleCompactions(session.id).length + idleCompactions(other.id).length, 0, "No compaction may run before the idle window");

  // A user compacts by hand right after a run: that is this stretch's compaction, so the plugin must not add another.
  const manual = await newSession(directory);
  await runOnce(host, manual.id, "manual compaction case [tag:manual]");
  await host.session.compact({ sessionID: manual.id });
  await waitFor("the manual compaction", () => idleCompactions(manual.id).at(0), 10_000);

  /** First compaction of a session must come a full idle window after the last keep-alive that session received. */
  const expectCompactionAfterWarming = async (label: string, tag: string, sessionID: string, settledAt: number) => {
    const compaction = await waitFor(`${label}: automatic idle compaction`, () => idleCompactions(sessionID).at(0), (CACHE_TTL_SECONDS + 8) * 1000);
    const keepAlives = providerRequests.filter(request => request.keepAlive && request.tag === tag && request.at <= compaction.created);
    assert(keepAlives.length >= 2, `${label}: warming must have run before the compaction, or the test proves nothing about it`);
    const gapMs = compaction.created - Math.max(...keepAlives.map(request => request.at));
    assert(gapMs >= IDLE_SECONDS * 1000 - 150, `${label}: compaction fired before the final keep-alive plus the idle window: ${gapMs}ms`);
    assert(gapMs < CACHE_TTL_SECONDS * 1000, `${label}: compaction fired at/after cache TTL: ${gapMs}ms after the final keep-alive`);
    assert(compaction.created > settledAt, `${label}: compaction must follow the settled run`);
    return { keepAlives: keepAlives.length, gapMs };
  };
  const main = await expectCompactionAfterWarming("main location", "main", session.id, settled.created);
  const second = await expectCompactionAfterWarming("other location", "other", other.id, otherSettled.created);

  await Bun.sleep((CACHE_TTL_SECONDS + 1) * 1000);
  assert.equal(idleCompactions(session.id).length, 1, "Exactly one automatic compaction per idle stretch");
  assert.equal(idleCompactions(other.id).length, 1, "A second location's instance must not add a duplicate compaction");
  assert.equal(idleCompactions(oldSession.id).length, 0, "The old chat stays untouched after the new chats compact");
  assert.equal(idleCompactions(manual.id).length, 1, "A manual compaction cancels the countdown, so the plugin adds none");
  assert.equal(announcedFor(manual.id), 0, "The plugin must not decide to compact a session the user just compacted");
  assert.equal(announcedFor(other.id), 1, "The other location is compacted by exactly one plugin instance");
  assert.equal(announcedFor(oldSession.id), 0, "The old chat is never a candidate");

  const secondRunStarted = providerRequests.length;
  await runOnce(host, session.id, "second prompt after idle compaction [tag:main]");
  assert(providerRequests.length > secondRunStarted, "The user prompt must reach the provider");
  await waitFor("second automatic idle compaction after a new prompt", () => (idleCompactions(session.id).length >= 2 ? true : undefined), (CACHE_TTL_SECONDS + 5) * 1000);
  await Bun.sleep((CACHE_TTL_SECONDS + 1) * 1000);
  assert.equal(idleCompactions(session.id).length, 2, "A new user prompt starts exactly one new idle stretch");
  assert.equal(idleCompactions(other.id).length, 1, "The untouched second location stays at one compaction");

  // The decision log must explain every compaction: who decided, in which location, and after which keep-alives.
  type Decision = { event: string; sessionID?: string; instance: string; via?: string; by?: string; ok?: boolean };
  const decisions = (await Bun.file(decisionLogPath).text()).trim().split("\n").map(line => JSON.parse(line) as Decision);
  const forSession = (sessionID: string) => decisions.filter(decision => decision.sessionID === sessionID);
  assert.equal(forSession(oldSession.id).length, 0, "The old chat must leave no trace: it was never owned");
  for (const [label, target, where] of [["main", session.id, directory], ["other", other.id, otherDirectory]] as const) {
    const entries = forSession(target);
    const compacting = entries.filter(decision => decision.event === "compacting");
    assert(compacting.length >= 1, `${label}: the log must record the compaction decision`);
    assert(compacting.every(decision => decision.instance === where), `${label}: only the instance that owns the location may decide to compact`);
    assert(entries.some(decision => decision.event === "armed" && decision.via === "keepalive"), `${label}: the log must show a keep-alive re-arming the countdown`);
    assert(entries.some(decision => decision.event === "compaction-seen" && decision.by === "plugin"), `${label}: the compaction must be attributed to the plugin`);
    assert(entries.some(decision => decision.event === "compact-result" && decision.ok === true), `${label}: the result must be recorded`);
    assert(entries.every(decision => decision.instance === where), `${label}: no other instance may log anything about this session`);
  }
  const manualEntries = forSession(manual.id);
  assert(manualEntries.some(decision => decision.event === "compaction-seen" && decision.by === "other"), "A user's compaction must be attributed to someone else");
  assert(!manualEntries.some(decision => decision.event === "compacting"), "No compaction decision for the manually compacted session");
  assert(decisions.some(decision => decision.event === "loaded"), "Each instance logs its configuration when it loads");

  console.log(JSON.stringify({
    nativeEnforcement: "verified",
    idleSeconds: IDLE_SECONDS,
    cacheTtlSeconds: CACHE_TTL_SECONDS,
    decisionLogLines: decisions.length,
    oldChatCompactions: idleCompactions(oldSession.id).length,
    keepAlivesBeforeCompaction: { main: main.keepAlives, other: second.keepAlives },
    idleGapFromFinalKeepAliveMs: { main: main.gapMs, other: second.gapMs },
    automaticCompactions: { main: idleCompactions(session.id).length, other: idleCompactions(other.id).length },
    compactionReasons: idleCompactions(session.id).map(event => event.data?.reason),
  }));
} catch (error) {
  exitCode = 1;
  const catalog = await host?.plugin.list({ location: { directory } }).catch(() => undefined);
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : "unknown failure",
    plugins: catalog?.data.filter(plugin => plugin.id === "hffmnnj.autocompact").map(plugin => ({ id: plugin.id, status: plugin.state.status })),
    eventTypes: [...new Set(observed.map(event => event.type))],
    compactionFailures: observed.filter(event => event.type === "session.compaction.failed"),
    providerRequests: providerRequests.length,
  }));
} finally {
  await stopObserving?.();
  await host?.close();
  server.stop(true);
}
process.exit(exitCode);
