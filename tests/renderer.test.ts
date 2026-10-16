import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/output/renderer.js";
import { SessionSummary, TranslationMode, TranslatorOutput } from "../src/types/session.js";

function makeSession(overrides: Partial<SessionSummary["summary"]> = {}): SessionSummary {
  return {
    session_id: "sess-001",
    timestamp: "2026-06-12T10:00:00.000Z",
    source_tool: "claude-code",
    summary: {
      one_liner: "Built a Redis-backed rate limiter",
      problem_statement: "p",
      approach: "a",
      tradeoffs: [],
      dead_ends: [],
      technologies: ["Redis", "Express"],
      patterns_used: ["Middleware pattern"],
      ...overrides,
    },
  };
}

function makeOutput(mode: TranslationMode, overrides: Partial<TranslatorOutput> = {}): TranslatorOutput {
  return {
    mode,
    session_id: "sess-001",
    timestamp: "2026-06-12T10:00:00.000Z",
    content: "# Body\n\nContent here.",
    ...overrides,
  };
}

const MODE_TITLES: Record<TranslationMode, string> = {
  "interview-qa": "Interview Q&A",
  "portfolio-bullet": "Portfolio Bullets",
  "technical-deep-dive": "Technical Deep-Dive",
  "jd-tailoring": "Job Tailoring",
  "weekly-digest": "Weekly Digest",
};

describe("renderMarkdown", () => {
  it("produces stable frontmatter across all modes", () => {
    const modes: TranslationMode[] = ["interview-qa", "portfolio-bullet", "technical-deep-dive"];
    for (const mode of modes) {
      const md = renderMarkdown(makeOutput(mode), makeSession());

      expect(md.startsWith("---\n")).toBe(true);
      expect(md).toContain(`session_id: sess-001`);
      expect(md).toContain(`mode: ${mode}`);
      expect(md).toContain(`timestamp: 2026-06-12T10:00:00.000Z`);
      expect(md).toContain(`source_tool: claude-code`);
      expect(md).toContain(`one_liner: "Built a Redis-backed rate limiter"`);
      expect(md).toContain(`technologies: ["Redis", "Express"]`);
      expect(md).not.toContain("prompt_version:");
      expect(md).toContain(`# ${MODE_TITLES[mode]}`);
    }
  });

  it("escapes double quotes in the one_liner frontmatter value", () => {
    const session = makeSession({ one_liner: 'Built a "smart" rate limiter' });
    const md = renderMarkdown(makeOutput("portfolio-bullet"), session);

    expect(md).toContain('one_liner: "Built a \\"smart\\" rate limiter"');
  });

  it("includes prompt_version in frontmatter when the output declares one", () => {
    const output = makeOutput("interview-qa", { prompt_version: "interview-qa@v1" });
    const md = renderMarkdown(output, makeSession());

    expect(md).toContain("prompt_version: interview-qa@v1");
  });

  it("renders the body content after the header divider", () => {
    const md = renderMarkdown(makeOutput("portfolio-bullet"), makeSession());
    expect(md).toContain("# Body");
    expect(md).toContain("Content here.");
  });
});
