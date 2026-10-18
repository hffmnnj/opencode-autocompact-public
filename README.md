# opencode-autocompact

An OpenCode V2 plugin that compacts a primary session once it has been idle for a short window, before its prompt cache expires. It is the OpenCode equivalent of Claude Code's idle auto-compact.

## Behavior

- A run that settles (`session.execution.succeeded`, `failed`, or `interrupted`) starts an idle countdown. The default is **290 seconds**, just under the 5-minute prompt-cache lifetime, so the compaction request is dispatched while the cache is still warm.
- **Warming comes first.** The native `opencode.warming` plugin sends keep-alive requests while a session is idle. Each keep-alive restarts the countdown, so compaction fires **290 seconds after the final keep-alive**, once warming has stopped. Keep-alives are recognised by their prompt, which must match `warmingPrompt` (default: the native prompt). Warming disabled means the countdown runs from the settled run.
- A new user prompt, or any new execution, cancels the countdown.
- Compaction is requested with `session.compact({ delivery: "queue" })`. An idle session runs it immediately, and a racing user message is queued rather than injected into a running turn.
- **At most one automatic compaction per idle stretch.** The compaction run's own settlement does not start another countdown. A new user prompt starts a fresh stretch.
- **Cache-expiry guard.** The compaction fires only while the elapsed idle time is below `cacheTtlSeconds`. If the process was suspended and the timer wakes late, the cache has expired, and a cold compaction would re-read the full history and then pay for the summary too. In that case nothing happens.
- **Only sessions this plugin instance owns and has seen active.** The host loads one plugin instance per location (project directory). Session *events* reach every instance, but *hooks* reach only the instance whose location holds the session, and keep-alives are visible only through a hook. So a session becomes eligible only through a hook in its own instance: a user prompt or a model call (`context`). Events alone never create state, because an instance that cannot hear the keep-alives would fire at the settled run plus 290 seconds while warming is still running. Sessions that were idle when the plugin loaded are never compacted, and keep-alives alone do not make them eligible. Old chats stay untouched until they run again.
- **A compaction by anyone ends the stretch.** A manual `/compact` during the countdown cancels it, and no automatic one follows until the next user prompt.
- **Location check at fire time.** Before compacting, the instance re-reads the session and refuses unless the session's directory is its own. This is a second layer in case hooks ever stop being location-scoped.
- **Every decision is logged.** The host records the plugin's compactions as `reason: "manual"`, so the decision log is the only way to tell them from a user's. See [Decision log](#decision-log).
- **Fail-open.** Every hook and the event loop are wrapped. A bug in this plugin is reported once per error class and swallowed; it can never fail the session it watches.
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
- A run that began before the plugin loaded and settles afterwards is never compacted, because no hook of this instance saw it start. This case is covered by unit tests only; the native check uses a chat that finished before the reload.
- A session run only by something that fires neither the `prompt` nor the `context` hook is never owned, so it is never compacted. That fails safe.
- The native host records these compactions as `reason: "manual"`, because they go through the API.
- The timer uses wall-clock time. A suspended machine that wakes inside the TTL window still compacts warm. A wake after the TTL is skipped.

## Decision log

One JSON object per line, appended to `$XDG_STATE_HOME/opencode-autocompact/decisions.jsonl` (default `~/.local/state/opencode-autocompact/decisions.jsonl`). Set `logFile` to an absolute path to move it, or `false` to turn it off. It rotates to `decisions.jsonl.1` past 5 MB and never deletes. Lines hold session IDs, timings and event names only, never conversation text or native error messages.

Every line has `at`, `instance` (the location whose plugin instance decided) and `pid`, plus:

| `event` | Meaning |
| --- | --- |
| `loaded` / `disposed` | Instance start and stop, with the effective options. |
| `owned` | A prompt or model call reached this instance's hooks (`via`). Only then is a session a candidate. |
| `armed` | A countdown started (`via`: `settled` run or `keepalive`), with `fireInMs`. |
| `disarmed` | A pending countdown was cancelled, and `why`. |
| `keepalive-ignored`, `settle-ignored` | A signal changed nothing, and `why` (`running`, `already-compacted`). |
| `skipped` | The countdown ended without compacting: `cache-expired`, `ineligible`, `activity-during-lookup`. |
| `compacting` / `compact-result` | The request was sent, and whether it was accepted (`ok`, `errorName`). |
| `compaction-seen` | The host reported a compaction: `by: "plugin"` or `"other"` (a user's). |

Answering "why did it compact at 14:17?": `grep ses_xxx decisions.jsonl` shows the owning instance, each `armed` with its `via`, and whether a keep-alive ever re-armed it. The same `compacting` decision is also written to the server log as a `console.warn` line.

## Incident: compaction while warming (fixed)

The first live version compacted a session at exactly the settled run plus 290 seconds, although native warming had pinged it 54 seconds earlier. Cause, reproduced with a probe on a real two-location host: the plugin loads once per location, events reach all instances, hooks reach only the owner. The other instances armed a countdown from the events, never heard a keep-alive, and fired. Fix: ownership comes only from hooks, as described above. The host test now runs two locations and fails on the old code with `compaction fired before the final keep-alive plus the idle window: 16ms`.

## Incident: broken hot reload (process)

The host reloads this plugin from disk when its files change. A half-edited working tree was once live, and a hook threw `deps.trace is not a function`, which made the host log `Failed to drain Session` for several unrelated sessions. Two guards: develop on a branch and point the host at a separate clean checkout (a git worktree of `main`), and the fail-open wrapper above.

## Verification

- `bun run check`: typecheck, then the deterministic unit tests on an injected clock. They cover exactly 290s, the cache-TTL cutoff, a late wake, a prompt during the window, a pending eligibility lookup, once-per-stretch, keep-alive restarts, events for sessions the instance does not own, manual compactions, and the announcement.
- Decision-log unit tests cover the story of a warmed session, every cancel reason, every skip reason, own versus user compaction (including the host reporting it after `compact()` returned), failures logged by class name only, line format, concurrent appenders, an unwritable path, and rotation.
- `bun run test:host`: an isolated real OpenCode V2 host (2.0.25), restarted across a plugin load, with two locations, and the decision log checked for who decided, the keep-alive re-arm, the attribution and the result, a loopback scripted provider and native warming on (`interval 1s`, `duration 4s`; plugin `idleSeconds: 2`, `cacheTtlSeconds: 6`). It checks:
  - an old chat that finished before the plugin loaded gets no compaction, no keep-alive and no announcement;
  - in each location, the compaction comes a full idle window after that session's own last keep-alive, once per stretch, with no duplicate from the other instance;
  - a new prompt starts exactly one new stretch;
  - a manual compaction right after a run leaves the plugin with no compaction decision at all (checked through the announcement, because a repeat compaction of a compacted session leaves no host event).
- Fault injections, each in a scratch copy: the pre-fix code fails the two-location host test; removing the compaction hook fails the host test; letting events create state fails four unit tests; and the earlier ones (no TTL guard, no stale re-check, no once-per-stretch guard, prompt not cancelling, keep-alives ignored, running not guarded) fail their unit tests.

Not verified:
- The fire-time location check on its own. Hooks already keep other instances inert, so removing only the check passes every test. It is defence in depth, kept because the failure it guards against is silent.
- Whether native warming treats the automatic compaction as activity and extends its keep-alives for another 30 minutes. Code reading suggests it does.
- A live run with the default 290s/300s values, the subagent exclusion path under a real nested run, and whether the compaction request reuses the cached prefix on the provider side.
