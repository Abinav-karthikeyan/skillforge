import { describe, expect, it } from "vitest";
import { RETURN_ONLY, formatReturnOnly } from "../../src/output/return-only.js";
import { listConnectors } from "../../src/output/connectors/factory.js";
import { SessionSummary, TranslationMode, TranslatorOutput } from "../../src/types/session.js";

function makeSession(): SessionSummary {
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
    },
  };
}

function makeOutput(mode: TranslationMode): TranslatorOutput {
  return {
    mode,
    session_id: "sess-001",
    timestamp: "2026-06-12T10:00:00.000Z",
    content: "# Body\n\nContent here.",
  };
}

describe("return_only host-delivery mode", () => {
  it("registers 'return_only' as a selectable connector", () => {
    expect(listConnectors()).toContain(RETURN_ONLY);
  });

  it("embeds the fully rendered artifact (frontmatter + body), not just the raw content", () => {
    const out = formatReturnOnly(makeOutput("portfolio-bullet"), makeSession(), "/corpus/x.md");

    // Full render, so a host can pass it straight to a text source.
    expect(out).toContain("---\nsession_id: sess-001");
    expect(out).toContain("technologies: [\"Redis\", \"Express\"]");
    expect(out).toContain("# Body");
    expect(out).toContain("Content here.");
  });

  it("reports the local corpus path and a destination-agnostic delivery instruction", () => {
    const out = formatReturnOnly(makeOutput("interview-qa"), makeSession(), "/corpus/x.md");

    expect(out).toContain("Saved to local corpus: /corpus/x.md");
    expect(out).toContain("Deliver this artifact");
    // Not hardcoded to a single destination.
    expect(out).toMatch(/Slack/);
    expect(out).toMatch(/NotebookLM|Gemini-Notebook/);
  });
});
