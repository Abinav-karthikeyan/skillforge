import { existsSync, readFileSync } from "fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capturePayload } from "../../src/observer/capture.js";
import { Signal } from "../../src/observer/detectors.js";
import { deletedPaths, installedPackages, isGitCommit, parseCommitOutput, revertedPaths, testRunner } from "../../src/observer/normalize.js";
import { FIXTURE_NAMES, loadSessionFixture, ObserverSandbox } from "./helpers.js";

let box: ObserverSandbox;
let spawned: string[][];
const spawn = (args: string[]) => {
  spawned.push(args);
  return true;
};

beforeEach(() => {
  box = new ObserverSandbox();
  spawned = [];
});
afterEach(() => box.dispose());

describe("shell command classification", () => {
  it("recognizes test runners, commits, installs, deletions, and reverts", () => {
    expect(testRunner("npm test")).toBe("npm test");
    expect(testRunner("npx vitest run tests/a.test.ts")).toBe("vitest");
    expect(testRunner("python -m pytest -q")).toBe("pytest");
    expect(testRunner("go test ./...")).toBe("go test");
    expect(testRunner("cargo test --lib")).toBe("cargo test");
    expect(testRunner("dotnet test")).toBe("dotnet test");
    expect(testRunner("npm run build")).toBeNull();

    expect(isGitCommit('git commit -m "x"')).toBe(true);
    expect(isGitCommit("git status")).toBe(false);
    expect(parseCommitOutput("[main 3f2a9c1] feat: limiter\n 2 files changed")).toEqual({ sha: "3f2a9c1", message: "feat: limiter" });
    expect(parseCommitOutput("[feature/x (root-commit) 1a2b3c4] init")).toEqual({ sha: "1a2b3c4", message: "init" });

    expect(installedPackages("npm install ioredis zod@4 -D && npm test")).toEqual(["ioredis", "zod"]);
    expect(installedPackages("npm i @scope/pkg@1.2.3")).toEqual(["@scope/pkg"]);
    expect(installedPackages('pip install "fastapi>=0.110" pyjwt[crypto]')).toEqual(["fastapi", "pyjwt"]);
    expect(installedPackages("cargo add tokio --features full")).toEqual(["tokio"]);
    expect(installedPackages("npm install")).toEqual([]);

    expect(deletedPaths("rm -rf src/old && git rm docs/x.md")).toEqual(["src/old", "docs/x.md"]);
    expect(revertedPaths("git checkout -- src/a.ts")).toEqual(["src/a.ts"]);
    expect(revertedPaths("git restore --staged src/a.ts src/b.ts")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(revertedPaths("git reset --hard HEAD~1")).toEqual(["*"]);
    expect(revertedPaths("git stash")).toEqual(["*"]);
    expect(revertedPaths("git stash pop")).toEqual([]);
    expect(revertedPaths("git checkout main")).toEqual([]);
  });
});

describe("capture gating", () => {
  it("records nothing for a repository that hasn't opted in", () => {
    const off = { ...box.settings, enabled: [] };
    const r = capturePayload(box.payload({ hook_event_name: "UserPromptSubmit", prompt: "hi" }, "s1"), { settings: off, journal: box.journal, spawn });
    expect(r.skipped).toMatch(/not enabled/);
    expect(existsSync(box.journal.eventsPath("s1"))).toBe(false);
  });

  it("never throws on garbage input", () => {
    for (const raw of ["", "not json", "42", "null", "[]"]) {
      expect(() => capturePayload(raw, { settings: box.settings, journal: box.journal, spawn })).not.toThrow();
    }
  });
});

describe("capture → journal", () => {
  it("appends redacted, sequenced events with transcript watermarks", () => {
    const secret = "sk-" + "ant-" + "x".repeat(30);
    capturePayload(box.payload({ hook_event_name: "UserPromptSubmit", prompt: `use key ${secret}`, transcript_path: box.repo.root + "/README.md" }, "s1"), {
      settings: box.settings,
      journal: box.journal,
      spawn,
    });
    capturePayload(box.payload({ hook_event_name: "Stop", last_assistant_message: "done" }, "s1"), { settings: box.settings, journal: box.journal, spawn });

    const raw = readFileSync(box.journal.eventsPath("s1"), "utf-8");
    expect(raw).not.toContain(secret);
    const events = box.journal.readEvents("s1");
    expect(events.map((e) => [e.id, e.kind])).toEqual([["e1", "prompt"], ["e2", "turn_end"]]);
    expect(events[0].redacted).toBe(true);
    expect(events[0].transcript_ref?.offset).toBeGreaterThan(0);
    const state = box.journal.loadState("s1")!;
    expect(state.seq).toBe(2);
    expect(state.repo).toBe(box.repo.root);
  });
});

describe("boundary detectors on replay fixtures (deterministic recall)", () => {
  for (const name of FIXTURE_NAMES) {
    it(`${name}: finds every gold boundary`, () => {
      const fx = loadSessionFixture(name);
      const signals: Signal[] = [];
      for (const p of fx.payloads) {
        const r = capturePayload(box.payload(p, fx.session_id), {
          settings: { ...box.settings, observer: "off" },
          journal: box.journal,
          spawn,
        });
        signals.push(...r.signals);
      }
      const of = (k: Signal["kind"]) => signals.filter((s) => s.kind === k);

      for (const g of fx.gold.dead_ends) expect(of("dead_end").map((s) => s.detail).join(" | ")).toContain(g.detector);
      for (const g of fx.gold.debug_arcs) expect(of("debug_arc").map((s) => s.detail).join(" | ")).toContain(g.detector);
      expect(of("tradeoff_candidate").length).toBeGreaterThanOrEqual(fx.gold.tradeoffs.length);
      for (const dep of fx.gold.dependencies) expect(of("dependency").map((s) => s.detail).join(" ")).toContain(dep);
      expect(of("checkpoint")).toHaveLength(fx.gold.checkpoints);
      expect(of("snapshot")).toHaveLength(fx.gold.snapshots);
      // Every signal cites events that exist in the journal.
      const ids = new Set(box.journal.readEvents(fx.session_id).map((e) => e.id));
      for (const s of signals) for (const id of s.event_ids) expect(ids.has(id)).toBe(true);
    });
  }
});

describe("warm/cold path triggers", () => {
  const run = (p: Record<string, unknown>, at: string, settings = box.settings) =>
    capturePayload(box.payload(p, "s1"), { settings, journal: box.journal, spawn, now: () => new Date(at) });

  it("spawns the observer at a milestone, then debounces", () => {
    run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: 'git commit -m "a"' }, tool_response: { stdout: "[main aaaaaaa] a" } }, "2026-10-16T10:00:00Z");
    expect(spawned).toEqual([["--session", "s1"]]);
    run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: 'git commit -m "b"' }, tool_response: { stdout: "[main bbbbbbb] b" } }, "2026-10-16T10:00:30Z");
    expect(spawned).toHaveLength(1); // within observer_min_interval_s
    run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: 'git commit -m "c"' }, tool_response: { stdout: "[main ccccccc] c" } }, "2026-10-16T10:05:00Z");
    expect(spawned).toHaveLength(2);
  });

  it("respects the hourly observer budget, except for compaction snapshots", () => {
    for (let i = 0; i < box.settings.max_observer_calls_per_hour; i++) box.journal.recordObserverCall(Date.parse("2026-10-16T10:00:00Z"));
    run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: 'git commit -m "a"' }, tool_response: {} }, "2026-10-16T10:10:00Z");
    expect(spawned).toHaveLength(0);
    run({ hook_event_name: "PreCompact", trigger: "auto" }, "2026-10-16T10:11:00Z");
    expect(spawned).toEqual([["--session", "s1", "--force"]]);
  });

  it("captures but never spawns when the observer is off", () => {
    run({ hook_event_name: "PreCompact", trigger: "auto" }, "2026-10-16T10:00:00Z", { ...box.settings, observer: "off" });
    expect(spawned).toHaveLength(0);
    expect(box.journal.readEvents("s1")).toHaveLength(1);
  });

  it("spawns a detached reflection at SessionEnd and marks the session ended", () => {
    run({ hook_event_name: "SessionEnd", reason: "other" }, "2026-10-16T10:00:00Z");
    expect(spawned).toEqual([["--session", "s1", "--reflect"]]);
    expect(box.journal.loadState("s1")!.ended).toBe(true);
  });

  it("catches up on unreflected sessions at SessionStart", () => {
    capturePayload(box.payload({ hook_event_name: "UserPromptSubmit", prompt: "x" }, "old"), {
      settings: box.settings, journal: box.journal, spawn: () => true, now: () => new Date("2026-10-15T00:00:00Z"),
    });
    run({ hook_event_name: "SessionStart", source: "startup" }, "2026-10-16T10:00:00Z");
    expect(spawned).toContainEqual(["--catch-up"]);
  });
});

describe("interaction contract", () => {
  it("notifies at SessionStart when candidates are waiting", () => {
    box.journal.writeInboxCount(2);
    const r = capturePayload(box.payload({ hook_event_name: "SessionStart", source: "startup" }, "s1"), { settings: box.settings, journal: box.journal, spawn });
    expect(r.output).toEqual({ systemMessage: expect.stringMatching(/^skill-forge: 2 story candidates waiting/) });
    const quiet = capturePayload(box.payload({ hook_event_name: "SessionStart", source: "resume" }, "s2"), {
      settings: { ...box.settings, notify: false }, journal: box.journal, spawn,
    });
    expect(quiet.output).toBeUndefined();
  });

  it("asks at most one question per session, only in opt-in question mode", () => {
    const settings = { ...box.settings, question: true, observer: "off" as const };
    const go = (p: Record<string, unknown>) => capturePayload(box.payload(p, "s1"), { settings, journal: box.journal, spawn });
    go({ hook_event_name: "UserPromptSubmit", prompt: "let's go with webhooks instead of polling" });
    const first = go({ hook_event_name: "Stop", last_assistant_message: "ok" });
    expect(first.output?.hookSpecificOutput).toMatchObject({ hookEventName: "Stop" });
    go({ hook_event_name: "UserPromptSubmit", prompt: "why not SSE rather than webhooks?" });
    expect(go({ hook_event_name: "Stop", last_assistant_message: "ok" }).output).toBeUndefined();

    const off = capturePayload(box.payload({ hook_event_name: "Stop", last_assistant_message: "x" }, "s3"), { settings: box.settings, journal: box.journal, spawn });
    expect(off.output).toBeUndefined();
  });
});

describe("capture performance (hot path)", () => {
  it("p95 under 50 ms per event", () => {
    const fx = loadSessionFixture("rate-limiter");
    const times: number[] = [];
    for (let round = 0; round < 10; round++) {
      for (const p of fx.payloads) {
        const t0 = performance.now();
        capturePayload(box.payload(p, `perf-${round}`), { settings: { ...box.settings, observer: "off" }, journal: box.journal, spawn });
        times.push(performance.now() - t0);
      }
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    expect(p95).toBeLessThan(50);
  });
});
