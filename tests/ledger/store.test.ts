import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { StoryLedger } from "../../src/ledger/store.js";
import { loadAllStories, migrateIndexToLedger, storiesFromIndex } from "../../src/ledger/migrate.js";
import { projectStory, StorySchema, ObservedEventSchema } from "../../src/types/ledger.js";
import { SessionSummary, SessionSummarySchema, TranslatorOutput } from "../../src/types/session.js";
import { Evidence } from "../../src/types/evidence.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "skillforge-ledger-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function session(overrides: Partial<SessionSummary["summary"]> = {}, storyId?: string): SessionSummary {
  return {
    session_id: "sess-1",
    story_id: storyId,
    timestamp: "2026-10-01T10:00:00.000Z",
    source_tool: "claude-code",
    summary: {
      one_liner: "Built a rate limiter",
      problem_statement: "p",
      approach: "a",
      tradeoffs: [],
      dead_ends: [],
      technologies: ["Redis"],
      patterns_used: [],
      ...overrides,
    },
  };
}

function output(mode: TranslatorOutput["mode"] = "portfolio-bullet"): TranslatorOutput {
  return { mode, session_id: "sess-1", timestamp: "2026-10-01T10:00:00.000Z", content: "- x", prompt_version: `${mode}@v1` };
}

describe("data model v2 schemas", () => {
  it("accepts a v1 SessionSummary unchanged (schema_version/story_id/evidence are optional)", () => {
    const parsed = SessionSummarySchema.parse(session());
    expect(parsed.schema_version).toBeUndefined();
    expect(parsed.story_id).toBeUndefined();
    expect("evidence" in parsed.summary).toBe(false);
  });

  it("rejects an ObservedEvent that is not marked redacted", () => {
    const base = { id: "e1", host: "claude-code", session_id: "s", ts: "t", kind: "prompt" };
    expect(ObservedEventSchema.safeParse({ ...base, redacted: true }).success).toBe(true);
    expect(ObservedEventSchema.safeParse({ ...base, redacted: false }).success).toBe(false);
    expect(ObservedEventSchema.safeParse(base).success).toBe(false);
  });

  it("projects a story into a SessionSummary the translators accept", () => {
    const story = StorySchema.parse({
      story_id: "story-1",
      title: "Built a rate limiter",
      status: "approved",
      version: 3,
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-02T00:00:00.000Z",
      session_ids: ["s-a", "s-b"],
      summary: session().summary,
    });
    const projected = projectStory(story);
    expect(SessionSummarySchema.parse(projected)).toEqual(projected);
    expect(projected.schema_version).toBe(2);
    expect(projected.story_id).toBe("story-1");
    expect(projected.session_id).toBe("s-b");
    expect(projected.summary.one_liner).toBe("Built a rate limiter");
  });

  it("projects a legacy story without a summary from its title", () => {
    const story = StorySchema.parse({
      story_id: "legacy",
      title: "Old artifact",
      status: "approved",
      version: 1,
      created_at: "t",
      updated_at: "t",
      origin: "legacy-index",
    });
    expect(projectStory(story).summary.one_liner).toBe("Old artifact");
  });
});

describe("StoryLedger", () => {
  it("creates a story on first generation and keys it by session_id when no story_id is set", () => {
    const ledger = new StoryLedger(tempDir());
    const story = ledger.recordGeneration(session(), [{ output: output(), location: "/a/2026-10-01-x.md" }], "now");
    expect(story.story_id).toBe("sess-1");
    expect(story.version).toBe(1);
    expect(story.status).toBe("approved");
    expect(story.artifacts).toEqual([
      { mode: "portfolio-bullet", file: "2026-10-01-x.md", version: 1, prompt_version: "portfolio-bullet@v1", written_at: "2026-10-01T10:00:00.000Z" },
    ]);
    expect(ledger.get("sess-1")).toEqual(story);
  });

  it("bumps the version only when the summary content changes, and keeps history", () => {
    const ledger = new StoryLedger(tempDir());
    ledger.recordGeneration(session({}, "story-x"), [{ output: output(), location: "f.md" }], "t1");
    const same = ledger.recordGeneration(session({}, "story-x"), [{ output: output("interview-qa"), location: "q.md" }], "t2");
    expect(same.version).toBe(1);
    expect(same.artifacts.map((a) => a.mode).sort()).toEqual(["interview-qa", "portfolio-bullet"]);

    const changed = ledger.recordGeneration(
      session({ approach: "switched to GCRA" }, "story-x"),
      [{ output: output(), location: "f.md" }],
      "t3"
    );
    expect(changed.version).toBe(2);
    expect(changed.summary?.approach).toBe("switched to GCRA");
    expect(ledger.history("story-x").map((s) => s.version)).toEqual([1]);
  });

  it("records URLs from remote connectors verbatim", () => {
    const ledger = new StoryLedger(tempDir());
    const story = ledger.recordGeneration(session(), [{ output: output(), location: "https://gist.github.com/abc" }]);
    expect(story.artifacts[0].file).toBe("https://gist.github.com/abc");
  });

  it("stores evidence from the summary and resolves it by id (last write wins)", () => {
    const ledger = new StoryLedger(tempDir());
    const ev = (summary: string): Evidence => ({
      id: "ev-1",
      kind: "commit",
      source: { provider: "git", sha: "abc123", retrieved_at: "t" },
      summary,
      confidence: 1,
    });
    const story = ledger.recordGeneration(session({ evidence: [ev("first")] }), [{ output: output(), location: "f.md" }]);
    expect(story.evidence_ids).toEqual(["ev-1"]);
    ledger.putEvidence([ev("second")]);
    expect(ledger.getEvidence(["ev-1", "missing"]).map((e) => e.summary)).toEqual(["second"]);
  });

  it("appends and lists observations per session", () => {
    const ledger = new StoryLedger(tempDir());
    ledger.appendObservations([
      { id: "o1", session_id: "s1", kind: "dead_end", claim: "tried passport.js", evidence_ids: [], confidence: 0.8, ts: "t" },
      { id: "o2", session_id: "s2", kind: "tradeoff", claim: "RS256 over HS256", evidence_ids: [], confidence: 0.9, ts: "t" },
    ]);
    expect(ledger.listObservations("s1").map((o) => o.id)).toEqual(["o1"]);
    expect(ledger.listObservations().map((o) => o.id).sort()).toEqual(["o1", "o2"]);
  });

  it("sets status and refuses unknown stories", () => {
    const ledger = new StoryLedger(tempDir());
    ledger.recordGeneration(session(), [{ output: output(), location: "f.md" }]);
    expect(ledger.setStatus("sess-1", "discarded").status).toBe("discarded");
    expect(() => ledger.setStatus("nope", "approved")).toThrow(/No story/);
  });

  it("keeps story ids with path characters inside the ledger directory", () => {
    const dir = tempDir();
    const ledger = new StoryLedger(dir);
    ledger.recordGeneration(session({}, "../../escape"), [{ output: output(), location: "f.md" }]);
    expect(ledger.get("../../escape")?.story_id).toBe("../../escape");
    expect(ledger.list()).toHaveLength(1);
  });
});

describe("legacy index migration", () => {
  function writeLegacyIndex(dir: string): void {
    const entries = [
      { session_id: "s-old", mode: "portfolio-bullet", timestamp: "2026-06-01T00:00:00.000Z", file: "a.md", one_liner: "Old one" },
      { session_id: "s-old", mode: "interview-qa", timestamp: "2026-06-01T00:01:00.000Z", file: "b.md", one_liner: "Old one" },
      { session_id: "s-other", mode: "portfolio-bullet", timestamp: "2026-06-02T00:00:00.000Z", file: "c.md", one_liner: "Other" },
    ];
    // Same shape the v2 connector appended: one single-element sequence per entry.
    writeFileSync(join(dir, "index.yml"), entries.map((e) => stringify([e])).join(""), "utf-8");
  }

  it("groups legacy entries by session into one-version stories", () => {
    const dir = tempDir();
    writeLegacyIndex(dir);
    const ledger = StoryLedger.forArtifactsDir(dir);
    const stories = loadAllStories(dir, ledger);
    expect(stories.map((s) => s.story_id)).toEqual(["s-old", "s-other"]);
    const old = stories[0];
    expect(old.origin).toBe("legacy-index");
    expect(old.version).toBe(1);
    expect(old.artifacts.map((a) => a.mode).sort()).toEqual(["interview-qa", "portfolio-bullet"]);
    expect(old.summary).toBeUndefined();
  });

  it("migrates idempotently and lets ledger stories win over legacy ones", () => {
    const dir = tempDir();
    writeLegacyIndex(dir);
    const ledger = StoryLedger.forArtifactsDir(dir);
    expect(migrateIndexToLedger(dir, ledger)).toEqual({ created: 2, skipped: 0 });
    expect(migrateIndexToLedger(dir, ledger)).toEqual({ created: 0, skipped: 2 });
    ledger.setStatus("s-old", "discarded");
    const old = loadAllStories(dir, ledger).find((s) => s.story_id === "s-old");
    expect(old?.status).toBe("discarded");
  });

  it("treats a missing index as no stories", () => {
    expect(storiesFromIndex([])).toEqual([]);
    const dir = tempDir();
    expect(loadAllStories(dir, StoryLedger.forArtifactsDir(dir))).toEqual([]);
  });
});
