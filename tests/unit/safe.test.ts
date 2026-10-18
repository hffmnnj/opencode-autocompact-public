import { describe, expect, test } from "bun:test";
import { failOpen } from "../../src/safe";

describe("failOpen", () => {
  test("passes arguments through and never throws into the host when the observer does", () => {
    const seen: string[] = [];
    const reports: string[] = [];
    const ok = failOpen("hook", (value: string) => void seen.push(value), message => reports.push(message));
    const broken = failOpen("hook", (_value: string) => {
      throw new TypeError("deps.trace is not a function");
    }, message => reports.push(message));

    ok("a");
    expect(() => broken("b")).not.toThrow();
    expect(seen).toEqual(["a"]);
    expect(reports).toEqual(["hook failed (TypeError); the session was not affected"]);
  });

  test("reports a repeating fault once, and never includes the error message", () => {
    const reports: string[] = [];
    const broken = failOpen("hook", () => {
      throw new Error("conversation text");
    }, message => reports.push(message));
    for (let i = 0; i < 5; i++) broken();

    expect(reports).toHaveLength(1);
    expect(reports[0]).not.toContain("conversation text");
  });
});
