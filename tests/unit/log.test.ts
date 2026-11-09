import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createDecisionLog, defaultLogPath, formatLine, type LogContext } from "../../src/log";

const context: LogContext = { instance: "/work/project", now: () => Date.UTC(2026, 9, 18, 14, 21, 53), pid: 4242 };
const root = await mkdtemp(join(tmpdir(), "autocompact-log-"));

describe("decision log lines", () => {
  test("carry the time, the instance that decided, and the decision, as one JSON line", () => {
    const line = formatLine({ event: "compacting", sessionID: "ses_a", idleMs: 290_000 }, context);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      at: "2026-10-18T14:21:53.000Z",
      instance: "/work/project",
      pid: 4242,
      event: "compacting",
      sessionID: "ses_a",
      idleMs: 290_000,
    });
  });

  test("defaults under XDG_STATE_HOME, and falls back to ~/.local/state", () => {
    expect(defaultLogPath({ XDG_STATE_HOME: "/state" })).toBe(join("/state", "opencode-autocompact", "decisions.jsonl"));
    expect(defaultLogPath({ XDG_STATE_HOME: "" })).toBe(join(homedir(), ".local", "state", "opencode-autocompact", "decisions.jsonl"));
  });
});

describe("decision log file", () => {
  test("appends lines in order, creating missing directories", async () => {
    const path = join(root, "nested", "dir", "a.jsonl");
    const log = createDecisionLog(path, context, () => undefined);
    log.sink({ event: "owned", sessionID: "ses_a", via: "prompt" });
    log.sink({ event: "armed", sessionID: "ses_a", via: "settled", fireInMs: 290_000 });
    await log.flush();

    const lines = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { event: string });
    expect(lines.map(line => line.event)).toEqual(["owned", "armed"]);
  });

  test("two instances appending to one file never interleave inside a line", async () => {
    const path = join(root, "shared.jsonl");
    const logs = ["/a", "/b"].map(instance => createDecisionLog(path, { ...context, instance }, () => undefined));
    for (let i = 0; i < 50; i++) for (const log of logs) log.sink({ event: "keepalive-ignored", sessionID: `ses_${i}`, why: "running" });
    await Promise.all(logs.map(log => log.flush()));

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(100);
    expect(new Set(lines.map(line => (JSON.parse(line) as { instance: string }).instance))).toEqual(new Set(["/a", "/b"]));
  });

  test("a log that cannot be written is reported once and never throws into compaction", async () => {
    const blocker = join(root, "blocker");
    await writeFile(blocker, "a file where a directory is needed");
    const warnings: string[] = [];
    const log = createDecisionLog(join(blocker, "x.jsonl"), context, message => warnings.push(message));
    log.sink({ event: "disposed" });
    log.sink({ event: "disposed" });
    await log.flush();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("automatic compaction is unaffected");
  });

  test("moves an oversized log aside to .1 instead of deleting it", async () => {
    const path = join(root, "big.jsonl");
    await writeFile(path, "x".repeat(5 * 1024 * 1024 + 1));
    const log = createDecisionLog(path, context, () => undefined);
    log.sink({ event: "disposed" });
    await log.flush();

    expect((await readFile(`${path}.1`, "utf8")).length).toBe(5 * 1024 * 1024 + 1);
    expect(JSON.parse((await readFile(path, "utf8")).trim()).event).toBe("disposed");
  });
});
