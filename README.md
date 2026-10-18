# opencode-autocompact

An OpenCode V2 plugin that compacts a primary session once it has been idle for a short window, before its prompt cache expires. It is the OpenCode equivalent of Claude Code's idle auto-compact.

## Behavior

- A run that settles (`session.execution.succeeded`, `failed`, or `interrupted`) starts an idle countdown. The default is **290 seconds**, just under the 5-minute prompt-cache lifetime, so the compaction request is dispatched while the cache is still warm.
- **Warming comes first.** The native `opencode.warming` plugin sends keep-alive requests while a session is idle. Each keep-alive restarts the countdown, so compaction fires **290 seconds after the final keep-alive**, once warming has stopped. Keep-alives are recognised by their prompt, which must match `warmingPrompt` (default: the native prompt). Warming disabled means the countdown runs from the settled run.
- A new user prompt, or any new execution, cancels the countdown.
- Compaction is requested with `session.compact({ delivery: "queue" })`. An idle session runs it immediately, and a racing user message is queued rather than injected into a running turn.
- **At most one automatic compaction per idle stretch.** The compaction run's own settlement does not start another countdown. A new user prompt starts a fresh stretch.
- **Cache-expiry guard.** The compaction fires only while the elapsed idle time is below `cacheTtlSeconds`. If the process was suspended and the timer wakes late, the cache has expired, and a cold compaction would re-read the full history and then pay for the summary too. In that case nothing happens.
- **Only sessions active under observation.** A session becomes eligible when this plugin sees it run (an execution starts) or receives a prompt after load. Sessions that were idle when the plugin loaded are never compacted, and keep-alives alone do not make them eligible. Old chats stay untouched until they run again.
- **Primary sessions only** by default. Child sessions (subagents) are skipped unless `includeSubagents` is set.

## Install

Add the plugin to the V2 config, keeping any existing entries:

```json
{
  "plugins": [
    { "package": "/path/to/opencode-autocompact" }
  ]
}
```

Options (all optional):

| Option | Default | Meaning |
| --- | --- | --- |
| `idleSeconds` | `290` | Idle time after a settled run before compacting. Must be less than `cacheTtlSeconds`. |
| `cacheTtlSeconds` | `300` | Prompt-cache lifetime. Use `3600` for accounts on the 1-hour tier and set `idleSeconds` accordingly (for example `3300`). |
| `includeSubagents` | `false` | Also compact child sessions. |
| `warmingPrompt` | native keep-alive prompt | Must match a customised `warming.prompt` in the host config. |

Keep the warming `interval` below `idleSeconds` (native default: 4 minutes against 290 seconds). A longer interval would let the countdown expire between keep-alives, so compaction could fire while warming is still running.

Unknown keys and invalid values fail at startup, so a typo cannot silently fall back to the default.

## Design notes

Claude Code shipped idle compaction in 2.1.286. Per GitHub issue anthropics/claude-code#66115 and its comments, it was on by default, fired around 54 minutes into the 1-hour cache, and announced itself only after the fact ("Compacted while idle, before the prompt cache expired"). Users reported losing important context and asked for an opt-in, a visible countdown, a context floor, and at most one compaction per idle stretch. This plugin keeps the one-per-stretch rule and makes the window explicit and configurable. It is opt-in by installation, and it has no context-size floor yet. Add one if small sessions turn out to be a waste.

## Limits

- Compaction is lossy and is a model call. It runs whether or not you intended to come back.
- Eligibility is in memory and resets on every host restart. A session becomes eligible again only after it runs or receives a prompt under the new host.
- A run that began before the plugin loaded and settles afterwards is never compacted, because its start was not observed. This case is covered by unit tests only; the native check uses a chat that finished before the reload.
- The native host records these compactions as `reason: "manual"`, because they go through the API.
- The timer uses wall-clock time. A suspended machine that wakes inside the TTL window still compacts warm. A wake after the TTL is skipped.

## Verification

- `bun run check`: typecheck, then 24 deterministic unit tests on an injected clock. Boundary cases cover exactly 290s, the cache-TTL cutoff, a late wake, a prompt during the window, a pending eligibility lookup, and once-per-stretch behavior.
- Four production faults were injected into copies, and each turned the matching unit test red: no TTL guard, no stale re-check, no once-per-stretch guard, and a prompt that did not cancel the timer.
- Warming unit tests: keep-alive recognition, plus countdown restarts on keep-alives, ignored while running or after compaction. Mutants that ignore keep-alives or drop the running guard turn the matching tests red.
- `bun run test:host`: an isolated real OpenCode V2 host (2.0.25), restarted across a plugin load. An old chat that finished before the plugin loaded gets no compaction and no keep-alives through a full idle window plus TTL. The loopback scripted provider and native warming are on (`interval 1s`, `duration 4s`). It loads the plugin by path with `idleSeconds: 2` and `cacheTtlSeconds: 6`, then measures from the last keep-alive the provider actually received. It checks one compaction per stretch and a fresh one after a new prompt. Copies with the prompt hook removed, or the keep-alive observer removed, fail the matching checks.

Not verified: whether native warming treats the automatic compaction as activity and extends its keep-alives for another 30 minutes. Code reading suggests it does, since the warming `compaction` hook counts any non-keep-alive request. A live run with the default 290s/300s values (the boundary is covered by unit tests and the config defaults by `config.test.ts`), the subagent exclusion path under a real nested run, and whether the compaction request reuses the cached prefix on the provider side.
