import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Trace, TraceSink } from "./trace";

const MAX_BYTES = 5 * 1024 * 1024;
const ROTATE_CHECK_EVERY = 500;

/** `$XDG_STATE_HOME/opencode-autocompact/decisions.jsonl`, falling back to `~/.local/state`. */
export function defaultLogPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const state = env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0 ? env.XDG_STATE_HOME : join(homedir(), ".local", "state");
  return join(state, "opencode-autocompact", "decisions.jsonl");
}

export interface LogContext {
  /** Directory of the plugin instance that made the decision; the host loads one instance per location. */
  readonly instance: string;
  readonly now: () => number;
  readonly pid: number;
}

export interface DecisionLog {
  readonly sink: TraceSink;
  /** Resolves when every queued line has been written (or has failed). */
  flush(): Promise<void>;
}

/** One JSON object per line: easy to grep, and `O_APPEND` keeps lines from different instances intact. */
export function formatLine(trace: Trace, context: LogContext): string {
  return `${JSON.stringify({ at: new Date(context.now()).toISOString(), instance: context.instance, pid: context.pid, ...trace })}\n`;
}

/**
 * Fail-open: a logging problem is reported once and never reaches the compaction path. The previous file is kept as
 * `<path>.1` when the log grows past 5 MB; rotation renames, it never deletes.
 */
export function createDecisionLog(path: string, context: LogContext, warn: (message: string) => void): DecisionLog {
  let queue: Promise<void> = Promise.resolve();
  let written = 0;
  let warned = false;

  const rotateIfLarge = async (): Promise<void> => {
    const size = await stat(path).then(info => info.size, () => 0);
    if (size > MAX_BYTES) await rename(path, `${path}.1`);
  };

  const write = async (line: string): Promise<void> => {
    try {
      if (written++ % ROTATE_CHECK_EVERY === 0) {
        await mkdir(dirname(path), { recursive: true });
        await rotateIfLarge();
      }
      await appendFile(path, line, { mode: 0o600 });
    } catch {
      if (!warned) {
        warned = true;
        warn(`could not write the decision log at ${path}; automatic compaction is unaffected`);
      }
    }
  };

  return {
    sink: trace => {
      queue = queue.then(() => write(formatLine(trace, context)));
    },
    flush: () => queue,
  };
}
