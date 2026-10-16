import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { ChatOptions, LLMClient } from "../../src/claude/types.js";
import {
  extractArtifactBody,
  formatJudgeTable,
  judgeArtifact,
  modeFromFrontmatter,
} from "../../src/eval/judge.js";
import { checkMetricHonesty, extractNumbers } from "../../src/eval/metric-honesty.js";
import { renderMarkdown } from "../../src/output/renderer.js";
import { SessionSummary, SessionSummarySchema } from "../../src/types/session.js";
import { CalibrationConfig } from "../../src/types/config.js";

const fixture: SessionSummary = SessionSummarySchema.parse(
  JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "greenfield-auth-service.json"), "utf-8"))
);
const config: CalibrationConfig = { experience_level: "senior" };

describe("metric honesty (deterministic)", () => {
  it("ignores identifiers, versions, list markers, code, and dates", () => {
    const text = [
      "1. Signed tokens with RS256 instead of HS256 on Node v20 (claude-sonnet-4-6 era).",
      "2. Served keys over HTTP/2 — see issue #123 and `max_tokens: 4096`.",
      "Shipped on 2026-06-30 in release 1.2.3.",
    ].join("\n");
    expect(extractNumbers(text)).toEqual([]);
  });

  it("extracts real numeric claims, including commas, decimals, and units", () => {
    expect(extractNumbers("Cut p99 from 800ms to 120 ms, saving $40k across 1,200 hosts (99.9% uptime).")).toEqual([
      "800",
      "120",
      "40",
      "1,200",
      "99.9",
    ]);
  });

  it("treats 0 and 1 as words, not metrics", () => {
    expect(extractNumbers("Moved 1 service with 0 downtime")).toEqual([]);
  });

  it("scores 5 when every number is grounded in the summary", () => {
    const report = checkMetricHonesty(
      "Built auth across 14 files and 680 lines with 15-minute access tokens.",
      fixture
    );
    expect(report.unsupported).toEqual([]);
    expect(report.score).toBe(5);
    expect(report.numbers_found).toEqual(["14", "680", "15"]);
  });

  it("flags invented metrics and degrades the score with each one", () => {
    const report = checkMetricHonesty("Reduced login latency by 40% and cut incidents by 75% across 14 files.", fixture);
    expect(report.unsupported).toEqual(["40", "75"]);
    expect(report.score).toBe(3);
  });

  it("accepts extra ground truth (e.g. code facts)", () => {
    expect(checkMetricHonesty("Touched a module referenced from 37 files.", fixture).unsupported).toEqual(["37"]);
    expect(checkMetricHonesty("Touched a module referenced from 37 files.", fixture, [{ refs: 37 }]).unsupported).toEqual([]);
  });

  it("reports a vacuous 5 when the artifact states no numbers", () => {
    expect(checkMetricHonesty("Designed a stateless auth service.", fixture)).toEqual({
      score: 5,
      numbers_found: [],
      unsupported: [],
    });
  });
});

function judgeReply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    star_completeness: { score: 4, rationale: "complete" },
    specificity: { score: 5, rationale: "specific" },
    groundedness: { score: 3, rationale: "mostly", unsupported_claims: ["claims a load test"] },
    calibration_fit: { score: 4, rationale: "senior" },
    ...overrides,
  });
}

function mockClient(...replies: string[]): LLMClient & { calls: Array<{ user: string; opts?: ChatOptions }> } {
  const calls: Array<{ user: string; opts?: ChatOptions }> = [];
  let i = 0;
  return {
    calls,
    async chat(_system: string, user: string, opts?: ChatOptions) {
      calls.push({ user, opts });
      return replies[Math.min(i++, replies.length - 1)];
    },
  };
}

describe("judgeArtifact", () => {
  it("combines rubric scores with deterministic metric honesty", async () => {
    const client = mockClient(judgeReply());
    const result = await judgeArtifact(client, {
      mode: "interview-qa",
      artifact: "## Q1\nI touched 14 files and cut errors by 90%.",
      session: fixture,
      config,
    });
    expect(result.scores).toEqual({
      star_completeness: 4,
      specificity: 5,
      groundedness: 3,
      metric_honesty: 4,
      calibration_fit: 4,
    });
    expect(result.overall).toBe(4);
    expect(result.metric_honesty.unsupported).toEqual(["90"]);
    expect(result.unsupported_claims).toEqual(["claims a load test"]);
    expect(result.prompt_version).toBe("judge@v1");
    expect(client.calls[0].opts).toEqual({ temperature: 0 });
  });

  it("nulls STAR completeness outside interview-qa and averages the rest", async () => {
    const client = mockClient(judgeReply({ star_completeness: { score: 1, rationale: "n/a" } }));
    const result = await judgeArtifact(client, {
      mode: "portfolio-bullet",
      artifact: "- Built a JWT auth service.",
      session: fixture,
      config,
    });
    expect(result.scores.star_completeness).toBeNull();
    // specificity 5, groundedness 3, metric 5 (no numbers), calibration 4.
    expect(result.overall).toBe(4.25);
    expect(result.rationales.star_completeness).toBeUndefined();
  });

  it("retries once on unparseable output, then throws", async () => {
    const ok = mockClient("Sure! Here is my grade:", judgeReply());
    await expect(
      judgeArtifact(ok, { mode: "portfolio-bullet", artifact: "- x", session: fixture, config })
    ).resolves.toBeDefined();
    expect(ok.calls).toHaveLength(2);
    expect(ok.calls[1].user).toMatch(/not valid JSON/);

    const bad = mockClient("nope", "still nope");
    await expect(
      judgeArtifact(bad, { mode: "portfolio-bullet", artifact: "- x", session: fixture, config })
    ).rejects.toThrow(/unparseable/);
  });

  it("strips rendered frontmatter and header before judging", async () => {
    const body = "- Designed RS256-signed tokens across 14 files.";
    const rendered = renderMarkdown(
      { mode: "portfolio-bullet", session_id: "s", timestamp: "2026-06-30T09:00:00.000Z", content: body },
      fixture
    );
    expect(extractArtifactBody(rendered)).toBe(body);
    expect(modeFromFrontmatter(rendered)).toBe("portfolio-bullet");
    expect(extractArtifactBody(body)).toBe(body);

    const chat = vi.fn(async () => judgeReply());
    await judgeArtifact({ chat }, { mode: "portfolio-bullet", artifact: rendered, session: fixture, config });
    const system = (chat.mock.calls[0] as unknown[])[0] as string;
    expect(system).toContain(body);
    expect(system).not.toContain("session_id: fixture");
  });

  it("formats a comparable markdown table", async () => {
    const result = await judgeArtifact(mockClient(judgeReply()), {
      mode: "interview-qa",
      artifact: "x",
      session: fixture,
      config,
    });
    const table = formatJudgeTable([{ label: "fixture · interview-qa@v2", result }]);
    expect(table).toContain("| artifact | STAR | specific | grounded | metric | calib | overall |");
    expect(table).toContain("| fixture · interview-qa@v2 | 4 | 5 | 3 | 5 | 4 | **4.2** |");
  });
});
