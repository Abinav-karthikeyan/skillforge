import { beforeEach, describe, expect, it, vi } from "vitest";
import { ingestSession } from "../src/ingestor/index.js";
import { LLMClient } from "../src/claude/types.js";

vi.mock("../src/adapters/claude-code.js", () => ({
  gatherGitContext: () => ({
    git_log: "abc123 feat: add redis rate limiter\n",
    git_diff: "diff --git a/src/index.ts b/src/index.ts\n+export const limit = 100;\n",
  }),
  // v2 path: no structural digest. The digest path is covered in tests/codeintel/.
  gatherStructuralContext: async () => null,
}));

function mockClient(returnValue: string): LLMClient {
  return { chat: vi.fn().mockResolvedValue(returnValue) };
}

const VALID_SUMMARY = {
  one_liner: "Built a Redis-backed rate limiter",
  problem_statement: "The API was being hammered by a single client",
  approach: "Implemented a sliding-window limiter using Redis sorted sets",
  tradeoffs: [
    {
      decision: "Sliding window over fixed window",
      reasoning: "Smoother rate limiting, harder to game",
      alternative_considered: "Fixed window counter",
    },
  ],
  dead_ends: ["Tried in-memory state first"],
  technologies: ["Redis", "Express", "Node.js"],
  patterns_used: ["Middleware pattern", "Sliding window"],
  complexity_signals: {
    files_touched: 6,
    lines_changed: 230,
    test_coverage: true,
    debugging_involved: true,
  },
};

const VALID_RAW = JSON.stringify({
  session_id: "sess-001",
  timestamp: "2026-06-12T10:00:00.000Z",
  source_tool: "claude-code",
  summary: VALID_SUMMARY,
});

describe("ingestSession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("parses and validates a pre-formed raw JSON session without calling the LLM", async () => {
    const client = mockClient("");
    const session = await ingestSession(client, VALID_RAW);

    expect(client.chat).not.toHaveBeenCalled();
    expect(session.session_id).toBe("sess-001");
    expect(session.summary.one_liner).toBe("Built a Redis-backed rate limiter");
    expect(session.summary.technologies).toContain("Redis");
    expect(session.summary.tradeoffs).toHaveLength(1);
  });

  it("rejects malformed input that violates the schema", async () => {
    const client = mockClient("");
    const malformed = JSON.stringify({ session_id: "x", timestamp: "y" });

    await expect(ingestSession(client, malformed)).rejects.toThrow();
    expect(client.chat).not.toHaveBeenCalled();
  });

  it("rejects non-JSON raw input", async () => {
    const client = mockClient("");
    await expect(ingestSession(client, "not json at all")).rejects.toThrow();
  });

  it("strips markdown fences from LLM output before parsing", async () => {
    const client = mockClient("```json\n" + VALID_RAW + "\n```");
    const session = await ingestSession(client);

    expect(session.summary.one_liner).toBe("Built a Redis-backed rate limiter");
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it("fills in session_id and timestamp when the LLM omits them", async () => {
    const rawWithoutIds = JSON.stringify({ source_tool: "claude-code", summary: VALID_SUMMARY });
    const client = mockClient(rawWithoutIds);

    const session = await ingestSession(client);

    expect(session.session_id).toBeTruthy();
    expect(session.timestamp).toBeTruthy();
    expect(session.source_tool).toBe("claude-code");
  });

  it("parses LLM output that includes fenced JSON with explanatory text trimmed", async () => {
    const client = mockClient('Here you go:\n```json\n' + VALID_RAW + '\n```\nEnjoy!');
    const session = await ingestSession(client);
    expect(session.summary.patterns_used).toContain("Sliding window");
  });
});
