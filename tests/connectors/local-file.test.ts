import { mkdtempSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFileConnector } from "../../src/output/connectors/local-file.js";
import { SessionSummary, TranslatorOutput } from "../../src/types/session.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "skillforge-local-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeSession(oneLiner = "Built a Redis-backed rate limiter"): SessionSummary {
  return {
    session_id: "sess-001",
    timestamp: "2026-06-12T10:00:00.000Z",
    source_tool: "claude-code",
    summary: {
      one_liner: oneLiner,
      problem_statement: "p",
      approach: "a",
      tradeoffs: [],
      dead_ends: [],
      technologies: ["Redis", "Express"],
      patterns_used: [],
    },
  };
}

function makeOutput(): TranslatorOutput {
  return {
    mode: "portfolio-bullet",
    session_id: "sess-001",
    timestamp: "2026-06-12T10:00:00.000Z",
    content: "- Accomplished X by doing Y.",
  };
}

describe("LocalFileConnector", () => {
  it("writes a markdown file with a slug-based filename", async () => {
    const dir = makeTempDir();
    const connector = new LocalFileConnector(dir);

    const filepath = await connector.write(makeOutput(), makeSession());

    expect(existsSync(filepath)).toBe(true);
    expect(filepath.endsWith(".md")).toBe(true);
    expect(filepath).toContain("2026-06-12-portfolio-bullet-built-a-redis-backed-rate-limiter.md");
    expect(readFileSync(filepath, "utf-8").startsWith("---\n")).toBe(true);
  });

  it("sanitizes the one_liner slug (lowercase, dashes, length-capped)", async () => {
    const dir = makeTempDir();
    const connector = new LocalFileConnector(dir);

    const filepath = await connector.write(
      makeOutput(),
      makeSession("Built the API Gateway v2: 'auth & billing' pipeline!")
    );

    const filename = filepath.split(/[\\/]/).pop()!;
    expect(filename.startsWith("2026-06-12-portfolio-bullet-")).toBe(true);
    expect(filename).not.toMatch(/['&!]/);
    expect(filename).toMatch(/^2026-06-12-portfolio-bullet-[a-z0-9-]+\.md$/);
  });

  it("appends one index.yml entry per write (idempotent append)", async () => {
    const dir = makeTempDir();
    const connector = new LocalFileConnector(dir);

    await connector.write(makeOutput(), makeSession("First artifact"));
    await connector.write(makeOutput(), makeSession("Second artifact"));

    const index = readFileSync(join(dir, "index.yml"), "utf-8");
    const entries = index.split("- session_id:").filter(Boolean);
    expect(entries).toHaveLength(2);
    expect(index).toContain("sess-001");
    expect(index).toContain("Second artifact");
  });

  it("safely round-trips a one_liner with YAML-hostile characters", async () => {
    const dir = makeTempDir();
    const connector = new LocalFileConnector(dir);

    // Quote, colon, and newline would all corrupt a hand-built YAML string.
    const hostile = 'Built a "smart" limiter: v2\nwith a wrapped line';
    await connector.write(makeOutput(), makeSession(hostile));

    const index = readFileSync(join(dir, "index.yml"), "utf-8");
    const entries = parse(index) as Array<{ one_liner: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].one_liner).toBe(hostile);
  });

  it("creates nested output directories on demand", async () => {
    const dir = makeTempDir();
    const nested = join(dir, "deep", "nested");
    const connector = new LocalFileConnector(nested);

    const filepath = await connector.write(makeOutput(), makeSession());

    expect(existsSync(filepath)).toBe(true);
  });
});
