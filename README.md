<p align="center">
  <img src="https://unpkg.com/hffmnnj.autocompact/assets/banner.png" alt="Autocompact: pack idle context down." width="100%">
</p>

# hffmnnj.autocompact

An [OpenCode](https://opencode.ai) V2 plugin that compacts a primary session after it has been idle for a short window, before the configured prompt-cache window expires. It is the OpenCode equivalent of Claude Code's idle auto-compact.

## Install

Reference the published package in the V2 config, keeping any existing plugin entries:

```json
{
  "plugins": [
    { "package": "hffmnnj.autocompact" }
  ]
}
```

Options are optional and can be passed alongside the package:

```json
{
  "plugins": [
    {
      "package": "hffmnnj.autocompact",
      "options": { "idleSeconds": 290, "cacheTtlSeconds": 300 }
    }
  ]
}
```

## Behavior

- A run that settles (`session.execution.succeeded`, `failed`, or `interrupted`) starts an idle countdown. The default is **290 seconds**, just under the configured five-minute cache window.
- **Warming comes first.** The native `opencode.warming` plugin sends keep-alive requests while a session is idle. Each keep-alive restarts the countdown, so compaction fires **290 seconds after the final keep-alive**, once warming has stopped. Keep-alives are recognised by their prompt, which must match `warmingPrompt` (default: the native prompt). With warming disabled, the countdown runs from the settled run.
- A new user prompt, model call, or execution cancels the pending countdown.
- Compaction is requested with `session.compact({ delivery: "queue" })`. An idle session runs it immediately, and a racing user message is queued rather than injected into a running turn.
- **At most one automatic compaction per idle stretch.** The compaction run's own settlement does not start another countdown. A new user prompt starts a fresh stretch.
- **Only sessions this plugin instance has seen active.** Session events reach every plugin instance, but hooks reach only the instance whose location owns the session. A session becomes eligible only through a `prompt` or `context` hook in its own instance, so sessions that were already idle when the plugin loaded are left untouched.
- **Primary sessions only** by default. Child sessions (subagents) are skipped unless `includeSubagents` is set.
- **OpenAI-provider sessions are exempt.** At fire time the plugin re-reads the session and skips it when the current model's `providerID` is `openai`.
- **Cache-expiry guard.** Compaction fires only while the elapsed idle time is below `cacheTtlSeconds` (default **300 seconds**). If the process was suspended and the timer wakes after this configured window, the plugin skips the attempt rather than risk a cold compaction. This does not guarantee a provider's actual cache retention or a cache hit.
- **A compaction by anyone ends the stretch.** A manual `/compact` during the countdown cancels it, and no automatic one follows until the next user prompt.
- **Location check at fire time.** Before compacting, the instance re-reads the session and refuses unless the session's directory is its own.
- **Every decision is logged** when the decision log is enabled. The host records these compactions as `reason: "manual"`, so with the log enabled the plugin's decision log is the only way to tell them from a user's.
- **Fail-open runtime observers.** Every hook and the event loop are wrapped. A bug in those observers is reported once per error class and swallowed; it cannot fail the session it watches.

## Warming

The native warming plugin sends a keep-alive as a generate request whose final message is exactly its prompt. Keep-alives emit no session events, so the request shape is the only signal that warming is still running.

For default settings, keep the warming `interval` below `idleSeconds` (native default: 4 minutes against 290 seconds). A longer interval would let the countdown expire between keep-alives, so compaction could fire while warming is still running. If you customise the native `warming.prompt`, set `warmingPrompt` to the same text so keep-alives are still recognised.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `idleSeconds` | `290` | Idle time after a settled run before compacting. Must be a positive integer less than `cacheTtlSeconds`. |
| `cacheTtlSeconds` | `300` | Prompt-cache lifetime used by the expiry guard. Use `3600` for accounts on the 1-hour tier and set `idleSeconds` accordingly (for example `3300`). |
| `includeSubagents` | `false` | Also compact child sessions. |
| `warmingPrompt` | native keep-alive prompt | Must match a customised `warming.prompt` in the host config. The default is `This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK`. |
| `logFile` | `$XDG_STATE_HOME/opencode-autocompact/decisions.jsonl` | Absolute path for the decision log, or `false` to disable it. Falls back to `~/.local/state` when `XDG_STATE_HOME` is unset or empty. |

Unknown options and invalid values are rejected when the plugin loads, so a typo cannot silently fall back to a default.

## Decision log

One JSON object per line, appended to `$XDG_STATE_HOME/opencode-autocompact/decisions.jsonl` (default `~/.local/state/opencode-autocompact/decisions.jsonl`). Set `logFile` to an absolute path to move it, or `false` to turn it off. Past 5 MB the active log rotates to `decisions.jsonl.1`, replacing any previous `.1`. Lines hold session IDs, timings, event names, option values and error class names, never conversation text or native error messages.

Every line has `at`, `instance` (the location whose plugin instance decided) and `pid`, plus:

| `event` | Meaning |
| --- | --- |
| `loaded` / `disposed` | Instance start and stop, with the effective options. |
| `owned` | A prompt or model call reached this instance's hooks (`via`). Only then is a session a candidate. |
| `armed` / `disarmed` | A countdown started (`via`: `settled` run or `keepalive`), or a pending countdown was cancelled (`why`). |
| `keepalive-ignored`, `settle-ignored` | A signal changed nothing, and `why`. |
| `skipped` | The countdown ended without compacting: `cache-expired`, `ineligible`, or `activity-during-lookup`. |
| `compacting` / `compact-result` | The request was sent, and whether it was accepted (`ok`, `errorName`). |
| `compaction-seen` | The host reported a compaction: `by: "plugin"` or `"other"` (a user's). |

The plugin does not use `ctx.storage`; eligibility is held in memory, and the optional decision log is a local file.

## Limitations

- Compaction is **lossy** and is a model call. It runs whether or not you intended to come back, and there is no context-size floor, so small sessions can be compacted too.
- Eligibility is in memory and resets on every host restart. A session becomes eligible again only after it runs or receives a prompt under the new host.
- A run that began before the plugin loaded and settles afterwards is never compacted, because no hook of this instance saw it start.
- A session run only by something that fires neither the `prompt` nor the `context` hook is never owned, so it is never compacted. That fails safe.
- A failed compaction request is logged and not retried until the next user prompt.
- The native host records these compactions as `reason: "manual"`, because they go through the API.
- The timer uses wall-clock time. A suspended machine that wakes inside the configured TTL window can still compact; a wake at or after the TTL is skipped.
