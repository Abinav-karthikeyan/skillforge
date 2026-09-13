import { describe, expect, it } from "vitest";
import {
  runFocusScout,
  renderFocusBlock,
  FocusBrief,
} from "../../src/orchestrator/focus.js";
import {
  SubagentRuntime,
  SubagentResult,
  SUBAGENT_TIMEOUT_MESSAGE,
} from "../../src/orchestrator/subagent/types.js";
import { LLMClient } from "../../src/claude/types.js";
import { SessionSummary } from "../../src/types/session.js";

// runFocusScout is the conductor: it must NEVER throw, degrading every failure
// mode to `{ brief: null, fallback_reason }` so the main pipeline keeps going.
// These tests inject a fake runtime to exercise each rung of that fallback
// ladder without a real provider call.

const client: LLMClient = {
  async chat() {
    throw new Error("client.chat should not be called when a runtime is injected");
  },
};

function makeSession(): SessionSummary {
  return {
    session_id: "sess-focus",
    timestamp: "2026-09-13T00:00:00.000Z",
    source_tool: "claude-code",
    summary: {
      one_liner: "Built a rate limiter",
      problem_statement: "p",
      approach: "a",
      tradeoffs: [],
      dead_ends: [],
      technologies: ["Redis"],
      patterns_used: [],
    },
  };
}

const validBrief: FocusBrief = {
  relevant_signals: ["rate limiting"],
  gaps_to_probe: ["load testing"],
  category_weights: {
    "system-design": 0.4,
    behavioural: 0.2,
    debugging: 0.2,
    "technical-depth": 0.2,
  },
  emphasis_notes: "Lead with the concurrency tradeoff.",
};

/** A runtime whose single turn returns fixed text (or throws a fixed error). */
function fakeRuntime(behavior: { text?: string; throws?: Error }): SubagentRuntime {
  return {
    name: "inline",
    async run(): Promise<SubagentResult> {
      if (behavior.throws) throw behavior.throws;
      return { text: behavior.text ?? "", elapsed_ms: 1 };
    },
  };
}

describe("runFocusScout — fallback ladder", () => {
  it("returns no-focus when no focus lens is supplied", async () => {
    const res = await runFocusScout(client, makeSession(), undefined, "low");
    expect(res).toEqual({ brief: null, fallback_reason: "no-focus" });
  });

  it("returns effort-off when effort is 'off'", async () => {
    const res = await runFocusScout(client, makeSession(), "distributed systems", "off");
    expect(res).toEqual({ brief: null, fallback_reason: "effort-off" });
  });

  it("parses a valid brief from the runtime", async () => {
    const runtime = fakeRuntime({ text: JSON.stringify(validBrief) });
    const res = await runFocusScout(client, makeSession(), "distributed systems", "low", {
      runtime,
    });
    expect(res.brief).toEqual(validBrief);
    expect(res.fallback_reason).toBeUndefined();
    expect(res.runtime_used).toBe("inline");
  });

  it("tolerates a fenced JSON code block from the runtime", async () => {
    const runtime = fakeRuntime({ text: "```json\n" + JSON.stringify(validBrief) + "\n```" });
    const res = await runFocusScout(client, makeSession(), "focus", "low", { runtime });
    expect(res.brief).toEqual(validBrief);
  });

  it("degrades to parse-error on non-JSON output", async () => {
    const runtime = fakeRuntime({ text: "I could not produce a brief." });
    const res = await runFocusScout(client, makeSession(), "focus", "low", { runtime });
    expect(res.brief).toBeNull();
    expect(res.fallback_reason).toBe("parse-error");
  });

  it("degrades to parse-error when the JSON fails schema validation", async () => {
    // Weight out of the [0,1] range — structurally JSON, semantically invalid.
    const bad = { ...validBrief, category_weights: { ...validBrief.category_weights, behavioural: 9 } };
    const runtime = fakeRuntime({ text: JSON.stringify(bad) });
    const res = await runFocusScout(client, makeSession(), "focus", "low", { runtime });
    expect(res.brief).toBeNull();
    expect(res.fallback_reason).toBe("parse-error");
  });

  it("classifies a timeout distinctly from a provider error", async () => {
    const runtime = fakeRuntime({ throws: new Error(SUBAGENT_TIMEOUT_MESSAGE) });
    const res = await runFocusScout(client, makeSession(), "focus", "low", { runtime });
    expect(res.brief).toBeNull();
    expect(res.fallback_reason).toBe("timeout");
  });

  it("degrades to provider-error on any other runtime failure", async () => {
    const runtime = fakeRuntime({ throws: new Error("429 rate limited") });
    const res = await runFocusScout(client, makeSession(), "focus", "low", { runtime });
    expect(res.brief).toBeNull();
    expect(res.fallback_reason).toBe("provider-error");
  });
});

describe("renderFocusBlock", () => {
  it("renders a brief as a fenced JSON block", () => {
    const out = renderFocusBlock(validBrief, "focus");
    expect(out.startsWith("```json")).toBe(true);
    expect(out).toContain("relevant_signals");
  });

  it("falls back to advisory raw focus text when there is no brief", () => {
    const out = renderFocusBlock(null, "distributed systems");
    expect(out).toContain("scout unavailable");
    expect(out).toContain("distributed systems");
  });

  it("renders (none) when there is neither a brief nor raw focus", () => {
    expect(renderFocusBlock(null, undefined)).toBe("(none)");
  });
});
