import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LLMClient } from "../../src/claude/types.js";
import { StoryLedger } from "../../src/ledger/store.js";
import { backfillTranscripts, parseDuration, transcriptToPayloads } from "../../src/observer/backfill.js";
import { capturePayload } from "../../src/observer/capture.js";
import { forgetSessions, sessionsForRepo } from "../../src/observer/forget.js";
import { approveStory, discardStory, listCandidates } from "../../src/observer/inbox.js";
import { installObserverHooks, OBSERVE_COMMAND, uninstallObserverHooks } from "../../src/observer/install.js";
import { reflectPending, reflectSession, storyIdForSession } from "../../src/observer/reflector.js";
import { renderEventLog, runObserverPass } from "../../src/observer/worker.js";
import { CalibrationConfig } from "../../src/types/config.js";
import { loadSessionFixture, ObserverSandbox } from "./helpers.js";

let box: ObserverSandbox;
let ledger: StoryLedger;
let config: CalibrationConfig;
let outDir: string;

/** One fake model for every role, routed by the system prompt. */
function fakeLLM(overrides: { observer?: (system: string) => string; reflector?: string } = {}): LLMClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async chat(system: string) {
      if (system.startsWith("You are the observer")) {
        calls.push("observer");
        return overrides.observer ? overrides.observer(system) : defaultObserverReply(system);
      }
      if (system.startsWith("You are the reflector")) {
        calls.push("reflector");
        return overrides.reflector ?? REFLECTOR_REPLY;
      }
      calls.push("translator");
      return "- Replaced a fixed-window limiter with a Redis token bucket.";
    },
  };
}

/** Cite the first two event ids in the log, plus one bogus id and one low-confidence claim. */
function defaultObserverReply(system: string): string {
  const ids = [...system.matchAll(/\[(e\d+) /g)].map((m) => m[1]);
  return JSON.stringify({
    observations: [
      { kind: "dead_end", claim: "Wrote a fixed-window limiter, then deleted it for a token bucket.", evidence: [ids[0], ids[1], "e999"].filter(Boolean), confidence: 0.9 },
      { kind: "tradeoff", claim: "Chose a token bucket over a fixed window to stop boundary bursts.", evidence: [ids[2] ?? ids[0]], confidence: 0.85 },
      { kind: "learning", claim: "A hunch with nothing behind it.", evidence: ["e999"], confidence: 0.9 },
      { kind: "milestone", claim: "Low-confidence guess.", evidence: [ids[0]], confidence: 0.3 },
    ],
  });
}

const REFLECTOR_REPLY = JSON.stringify({
  title: "Per-tenant token-bucket rate limiting",
  summary: {
    one_liner: "Built per-tenant rate limiting for the API gateway with a Redis token bucket",
    problem_statement: "One tenant could exhaust the public API.",
    approach: "Token bucket in Redis keyed by tenant.",
    tradeoffs: [{ decision: "Token bucket", reasoning: "No boundary bursts", alternative_considered: "Fixed window" }],
    dead_ends: ["Fixed-window counter — allowed 2x bursts at window edges"],
    technologies: ["TypeScript", "Redis"],
    patterns_used: ["Token bucket"],
  },
});

function captureFixture(name: string, sessionId?: string): string {
  const fx = loadSessionFixture(name);
  const id = sessionId ?? fx.session_id;
  for (const p of fx.payloads) {
    capturePayload(box.payload(p, id), { settings: { ...box.settings, observer: "off" }, journal: box.journal, spawn: () => true });
  }
  return id;
}

beforeEach(() => {
  box = new ObserverSandbox();
  outDir = join(box.home, "artifacts");
  config = { experience_level: "senior", output_dir: outDir, connector: "local" };
  ledger = StoryLedger.forArtifactsDir(outDir);
});
afterEach(() => box.dispose());

const deps = (client: LLMClient) => ({ journal: box.journal, ledger, config, settings: box.settings, client });

describe("observer pass (warm path)", () => {
  it("persists only grounded, confident observations with event evidence and advances the watermark", async () => {
    const session = captureFixture("rate-limiter");
    const client = fakeLLM();
    const r = await runObserverPass(session, { ...deps(client), force: true });

    expect(r.observations.map((o) => o.kind)).toEqual(["dead_end", "tradeoff"]);
    const deadEnd = r.observations[0];
    expect(deadEnd.evidence_ids).toEqual([`ev-${session}-e1`, `ev-${session}-e2`]); // bogus e999 dropped
    const ev = ledger.getEvidence(deadEnd.evidence_ids);
    expect(ev[0]).toMatchObject({ kind: "event", source: { provider: "journal:claude-code", symbol: "e1" } });
    expect(ledger.listObservations(session)).toHaveLength(2);

    const state = box.journal.loadState(session)!;
    expect(state.observed_through_seq).toBe(state.seq);
    expect(state.pending_signals).toEqual([]);
    expect(state.observer_runs).toBe(1);
    expect(box.journal.observerCallsInLastHour()).toBe(1);

    expect((await runObserverPass(session, { ...deps(client), force: true })).skipped).toMatch(/nothing new/);
  });

  it("respects the hourly budget unless forced, and one worker per session", async () => {
    const session = captureFixture("memory-leak");
    const client = fakeLLM();
    const capped = { ...deps(client), settings: { ...box.settings, max_observer_calls_per_hour: 0 } };
    expect((await runObserverPass(session, capped)).skipped).toMatch(/budget/);

    const release = box.journal.workerLock(session)!;
    expect((await runObserverPass(session, { ...deps(client), force: true })).skipped).toMatch(/another observer/);
    release();
    expect(client.calls).toEqual([]);
  });

  it("renders a bounded event log that keeps signal events and the tail", () => {
    const session = captureFixture("rate-limiter");
    const events = box.journal.readEvents(session);
    const log = renderEventLog(events, new Set(["e4"]), 600);
    expect(log).toContain("[e4 ");
    expect(log).toContain(`[${events[events.length - 1].id} `);
    expect(log).toMatch(/earlier event\(s\) omitted/);
    expect(log.length).toBeLessThan(900);
  });
});

describe("reflection (cold path) and the inbox", () => {
  it("turns a session into a candidate story, counted in the inbox", async () => {
    const session = captureFixture("rate-limiter");
    const client = fakeLLM();
    const r = await reflectSession(session, deps(client));

    expect(client.calls).toEqual(["observer", "reflector"]); // observes the tail first
    expect(r.story).toMatchObject({
      story_id: storyIdForSession(session),
      status: "candidate",
      origin: "observer",
      version: 1,
      title: "Per-tenant token-bucket rate limiting",
    });
    expect(r.story!.observation_ids).toHaveLength(2);
    expect(r.story!.evidence_ids.length).toBeGreaterThan(0);
    expect(listCandidates({ config, ledger }).map((s) => s.story_id)).toEqual([storyIdForSession(session)]);
    expect(box.journal.readInboxCount()).toBe(1);
    expect(box.journal.loadState(session)!.reflected_through_seq).toBe(box.journal.loadState(session)!.seq);
  });

  it("attaches code facts for commits made during the session", async () => {
    box.repo.write({ "src/limiter.ts": "export function allow(k: string) { return k.length > 0; }\n" }).commit("feat: limiter");
    const sha = box.repo.git("rev-parse", "HEAD").trim();
    const session = "with-commit";
    for (const p of [
      { hook_event_name: "UserPromptSubmit", prompt: "add a limiter" },
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: 'git commit -m "feat: limiter"' }, tool_response: { stdout: `[main ${sha.slice(0, 7)}] feat: limiter` } },
      { hook_event_name: "SessionEnd", reason: "other" },
    ]) {
      capturePayload(box.payload(p, session), { settings: { ...box.settings, observer: "off" }, journal: box.journal, spawn: () => true });
    }
    const r = await reflectSession(session, deps(fakeLLM()));
    expect(r.story?.code_facts?.entity_changes.map((c) => c.symbol)).toContain("allow");
    expect(r.story?.summary?.code_facts?.files_changed).toBe(1);
  });

  it("skips thin sessions without inventing a story", async () => {
    const session = captureFixture("memory-leak");
    const r = await reflectSession(session, deps(fakeLLM({ reflector: JSON.stringify({ title: null }) })));
    expect(r.skipped).toMatch(/too thin/);
    expect(ledger.list()).toEqual([]);
  });

  it("approval renders artifacts; later evidence updates the living artifact in place", async () => {
    const session = captureFixture("rate-limiter");
    const client = fakeLLM();
    await reflectSession(session, deps(client));
    const id = storyIdForSession(session);

    const { story, generated } = await approveStory(id, ["portfolio-bullet"], { config, ledger, journal: box.journal, client });
    expect(story.status).toBe("approved");
    const file = generated!.artifacts[0].location;
    expect(readFileSync(file, "utf-8")).toContain(`story_id: "${id}"`);
    expect(box.journal.readInboxCount()).toBe(0);

    // The session continues: more events, a new observation, a new reflection.
    capturePayload(box.payload({ hook_event_name: "UserPromptSubmit", prompt: "also add a burst allowance instead of a hard cap" }, session), {
      settings: { ...box.settings, observer: "off" }, journal: box.journal, spawn: () => true,
    });
    const r = await reflectSession(session, { ...deps(client), translatorClient: client });
    expect(r.changed).toBe(true);
    expect(r.story?.version).toBe(2);
    expect(r.regenerated).toEqual([file]);
    expect(readFileSync(file, "utf-8")).toMatch(/^version: 2$/m);
    expect(existsSync(join(outDir, "versions"))).toBe(true);
  });

  it("discards candidates", async () => {
    const session = captureFixture("auth-service");
    await reflectSession(session, deps(fakeLLM()));
    expect(discardStory(storyIdForSession(session), { config, ledger, journal: box.journal }).status).toBe("discarded");
    expect(listCandidates({ config, ledger })).toEqual([]);
  });

  it("reflectPending handles ended sessions and applies the journal TTL", async () => {
    captureFixture("rate-limiter");
    captureFixture("auth-service");
    const results = await reflectPending(deps(fakeLLM()));
    expect(results.map((r) => r.session).sort()).toEqual(["fixture-auth-service", "fixture-rate-limiter"]);
    expect(results.every((r) => r.story)).toBe(true);
  });
});

describe("forget", () => {
  it("deletes journals, observations, and observer stories — but not user-generated stories", async () => {
    const session = captureFixture("rate-limiter");
    await reflectSession(session, deps(fakeLLM()));
    ledger.put({
      story_id: "mine", title: "x", status: "approved", version: 1, created_at: "t", updated_at: "t",
      origin: "generate", source_tool: "claude-code", session_ids: [session], observation_ids: [], evidence_ids: [], artifacts: [],
    });

    expect(sessionsForRepo(box.journal, box.repo.root)).toEqual([session]);
    const r = forgetSessions([session], box.journal, ledger);
    expect(r.stories).toEqual([storyIdForSession(session)]);
    expect(box.journal.exists(session)).toBe(false);
    expect(ledger.listObservations(session)).toEqual([]);
    expect(ledger.get("mine")).not.toBeNull();
  });
});

describe("backfill from Claude Code transcripts", () => {
  function writeTranscript(root: string, cwd: string, sessionId: string): void {
    const dir = join(root, "C--proj");
    mkdirSync(dir, { recursive: true });
    const L = (o: Record<string, unknown>) => JSON.stringify({ sessionId, cwd, timestamp: "2026-10-01T10:00:00Z", ...o });
    const lines = [
      L({ type: "user", message: { role: "user", content: "Fix the flaky limiter test" } }),
      L({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } }),
      L({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Exit code 1\nFAIL limiter", is_error: true }] } }),
      L({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }] } }),
      L({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "Exit code 1\nFAIL limiter again", is_error: true }] } }),
      L({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "npm test" } }] } }),
      L({ type: "user", toolUseResult: { stdout: "14 passed" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "14 passed" }] } }),
      L({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fixed: the clock was not faked." }] } }),
      L({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto" } }),
      L({ type: "user", isCompactSummary: true, message: { role: "user", content: "Summary: fixed flaky test" } }),
      L({ type: "user", isMeta: true, message: { role: "user", content: "<system-reminder>ignored</system-reminder>" } }),
      L({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }),
    ];
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
  }

  it("converts transcripts to hook payloads", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-transcripts-"));
    try {
      writeTranscript(root, box.repo.root, "t-session");
      const raw = readFileSync(join(root, "C--proj", "t-session.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const events = transcriptToPayloads(raw).map((p) => p.hook_event_name);
      expect(events).toEqual([
        "UserPromptSubmit", "PostToolUseFailure", "PostToolUseFailure", "PostToolUse", "Stop", "PreCompact", "PostCompact", "SessionEnd",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("imports enabled repos once, with the same detectors as live capture", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-transcripts-"));
    try {
      writeTranscript(root, box.repo.root, "t-session");
      writeTranscript(join(root, "other"), join(tmpdir()), "elsewhere");
      const r = backfillTranscripts({ sinceMs: 0, settings: box.settings, journal: box.journal, transcriptsRoot: root });
      expect(r.imported).toEqual([{ session: "t-session", repo: box.repo.root, events: 8 }]);
      const state = box.journal.loadState("t-session")!;
      expect(state.pending_signals.map((s) => s.kind)).toEqual(expect.arrayContaining(["debug_arc", "snapshot"]));
      expect(state.ended).toBe(true);

      const again = backfillTranscripts({ sinceMs: 0, settings: box.settings, journal: box.journal, transcriptsRoot: root });
      expect(again.imported).toEqual([]);
      expect(again.skipped.map((s) => s.reason)).toContain("already in the journal");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("files a session that moved into an enabled repo under that repo, not its first cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-transcripts-"));
    try {
      writeTranscript(root, box.repo.root, "moved");
      const file = join(root, "C--proj", "moved.jsonl");
      const scratch = JSON.stringify({ sessionId: "moved", cwd: join(tmpdir(), "scratch"), timestamp: "2026-10-01T09:59:00Z", type: "user", message: { role: "user", content: "Plan the work" } });
      writeFileSync(file, `${scratch}\n${readFileSync(file, "utf-8")}`);
      const r = backfillTranscripts({ sinceMs: 0, settings: box.settings, journal: box.journal, transcriptsRoot: root });
      // 9 = the 8 events above plus the opening prompt that led into the repo.
      expect(r.imported).toEqual([{ session: "moved", repo: box.repo.root, events: 9 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses durations", () => {
    expect(parseDuration("30d")).toBe(30 * 86_400_000);
    expect(parseDuration("12h")).toBe(12 * 3_600_000);
    expect(() => parseDuration("soon")).toThrow();
  });
});

describe("hook installer", () => {
  it("merges into existing settings, is idempotent, and uninstalls only its own hooks", () => {
    const path = join(box.home, "settings.json");
    const userHook = { type: "command", command: "my-linter" };
    writeFileSync(path, JSON.stringify({ model: "x", hooks: { PostToolUse: [{ matcher: "Write", hooks: [userHook] }] } }));

    installObserverHooks(path);
    installObserverHooks(path);
    const installed = JSON.parse(readFileSync(path, "utf-8"));
    expect(installed.model).toBe("x");
    expect(installed.hooks.PostToolUse).toHaveLength(2);
    expect(installed.hooks.PostToolUse[0].hooks[0]).toEqual(userHook);
    const ours = installed.hooks.PostToolUse[1].hooks[0];
    expect(ours).toEqual({ type: "command", command: OBSERVE_COMMAND, async: true });
    expect(installed.hooks.SessionEnd[0].hooks[0]).toEqual({ type: "command", command: OBSERVE_COMMAND, timeout: 5 });
    expect(Object.keys(installed.hooks).sort()).toEqual(
      ["PostCompact", "PostToolUse", "PostToolUseFailure", "PreCompact", "SessionEnd", "SessionStart", "Stop", "SubagentStop", "UserPromptSubmit"]
    );

    uninstallObserverHooks(path);
    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.hooks).toEqual({ PostToolUse: [{ matcher: "Write", hooks: [userHook] }] });
  });
});
