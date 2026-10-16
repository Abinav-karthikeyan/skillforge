import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFileConnector } from "../../src/output/connectors/local-file.js";
import { readIndex } from "../../src/output/index-file.js";
import { readLastArtifact } from "../../src/output/last-artifact.js";
import { renderMarkdown } from "../../src/output/renderer.js";
import { formatReturnOnly } from "../../src/output/return-only.js";
import { SessionSummary, TranslatorOutput } from "../../src/types/session.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "skillforge-story-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function session(storyId?: string, oneLiner = "Built a rate limiter"): SessionSummary {
  return {
    session_id: "sess-1",
    story_id: storyId,
    timestamp: "2026-10-01T10:00:00.000Z",
    source_tool: "claude-code",
    summary: {
      one_liner: oneLiner,
      problem_statement: "p",
      approach: "a",
      tradeoffs: [],
      dead_ends: [],
      technologies: ["Redis"],
      patterns_used: [],
    },
  };
}

function output(mode: TranslatorOutput["mode"] = "portfolio-bullet", content = "- v1 body"): TranslatorOutput {
  return { mode, session_id: "sess-1", timestamp: "2026-10-01T10:00:00.000Z", content };
}

describe("LocalFileConnector — living artifacts (story_id upsert)", () => {
  it("upserts by (story_id, mode): one index entry, version climbs, filename stays stable", async () => {
    const dir = tempDir();
    const connector = new LocalFileConnector(dir);

    const first = await connector.write(output(), session("story-1"));
    const second = await connector.write(output("portfolio-bullet", "- v2 body"), session("story-1", "Renamed title"));

    expect(second).toBe(first);
    const entries = readIndex(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ story_id: "story-1", mode: "portfolio-bullet", version: 2, one_liner: "Renamed title" });
    expect(readFileSync(first, "utf-8")).toContain("- v2 body");
  });

  it("archives the superseded body under versions/ for diffing", async () => {
    const dir = tempDir();
    const connector = new LocalFileConnector(dir);
    const path = await connector.write(output(), session("story-1"));
    await connector.write(output("portfolio-bullet", "- v2 body"), session("story-1"));

    const stem = path.split(/[\\/]/).pop()!.replace(/\.md$/, "");
    const archived = join(dir, "versions", `${stem}.v1.md`);
    expect(existsSync(archived)).toBe(true);
    expect(readFileSync(archived, "utf-8")).toContain("- v1 body");
  });

  it("keeps separate entries per mode of the same story (--mode all)", async () => {
    const dir = tempDir();
    const connector = new LocalFileConnector(dir);
    for (const mode of ["interview-qa", "portfolio-bullet", "technical-deep-dive"] as const) {
      await connector.write(output(mode), session("story-1"));
    }
    expect(readIndex(dir).map((e) => e.mode)).toEqual(["interview-qa", "portfolio-bullet", "technical-deep-dive"]);
  });

  it("moves an upserted entry to the end so readLastArtifact returns the latest write", async () => {
    const dir = tempDir();
    const connector = new LocalFileConnector(dir);
    await connector.write(output(), session("story-1"));
    await connector.write(output(), session(undefined, "Unrelated append"));
    await connector.write(output("portfolio-bullet", "- newest"), session("story-1"));

    const last = readLastArtifact(dir);
    expect(last.entry.story_id).toBe("story-1");
    expect(last.markdown).toContain("- newest");
  });

  it("stamps story_id and version into frontmatter, matching the return_only rendering", async () => {
    const dir = tempDir();
    const connector = new LocalFileConnector(dir);
    const out = output();
    const s = session("story-1");
    const path = await connector.write(out, s);
    const onDisk = readFileSync(path, "utf-8");

    expect(onDisk).toContain('story_id: "story-1"');
    expect(onDisk).toContain("version: 1");
    expect(formatReturnOnly(out, s, path)).toContain(onDisk);
  });

  it("leaves story-less writes on the append path with byte-identical frontmatter", async () => {
    const dir = tempDir();
    const connector = new LocalFileConnector(dir);
    const out = output();
    await connector.write(out, session());
    await connector.write(out, session());

    expect(readIndex(dir)).toHaveLength(2);
    expect(out.artifact_version).toBeUndefined();
    const md = renderMarkdown(out, session());
    expect(md).not.toMatch(/^(story_id|version|evidence_ids):/m);
  });

  it("renders evidence ids into frontmatter when the summary carries evidence", () => {
    const s = session();
    s.summary.evidence = [
      { id: "ev-1", kind: "commit", source: { provider: "git", sha: "abc", retrieved_at: "t" }, summary: "x", confidence: 1 },
    ];
    expect(renderMarkdown(output(), s)).toContain('evidence_ids: ["ev-1"]');
  });
});
