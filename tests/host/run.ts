import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Each run gets a fresh isolated HOME/XDG tree. Evidence directories are retained, never recursively deleted.
const temporary = tmpdir();
const root = await mkdtemp(join(temporary, "autocompact-host-"));
const child = Bun.spawn([process.execPath, fileURLToPath(new URL("native.ts", import.meta.url)), root, temporary], {
  cwd: root,
  env: {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(root, "home"),
    TMPDIR: root,
    XDG_CONFIG_HOME: join(root, "config-home"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_CONFIG_DIR: join(root, "config"),
  },
  stdout: "pipe",
  stderr: "pipe",
  timeout: 120_000,
});
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
if (stdout.trim()) console.log(stdout.trim());
if (stderr.trim()) console.error(stderr.trim());
console.log(JSON.stringify({ evidence: root, exitCode }));
process.exit(exitCode);
