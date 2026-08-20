import { v4 as uuidv4 } from "uuid";
import { LLMClient } from "../claude/types.js";
import { callClaude } from "../claude/client.js";
import { gatherGitContext } from "../adapters/claude-code.js";
import { SessionSummary, SessionSummarySchema } from "../types/session.js";

const INGEST_SYSTEM = `You are a senior software engineer extracting structured context from a coding session.
Given git history and diff information, produce a JSON object matching this schema exactly:

{
  "session_id": "<uuid>",
  "timestamp": "<ISO8601>",
  "source_tool": "claude-code",
  "summary": {
    "one_liner": "<one sentence describing what was built or fixed>",
    "problem_statement": "<what problem was being solved>",
    "approach": "<how it was solved>",
    "tradeoffs": [{"decision": "...", "reasoning": "...", "alternative_considered": "..."}],
    "dead_ends": ["<things tried that didn't work>"],
    "technologies": ["<tech stack items>"],
    "patterns_used": ["<design patterns or architectural decisions>"],
    "complexity_signals": {
      "files_touched": <number>,
      "lines_changed": <number>,
      "test_coverage": <boolean>,
      "debugging_involved": <boolean>
    }
  }
}

Return ONLY valid JSON. No markdown fences, no explanation.`;

function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  if (fenced) return fenced[1].trim();
  return text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();
}

export async function ingestSession(
  client: LLMClient,
  rawJson?: string
): Promise<SessionSummary> {
  if (rawJson) {
    const parsed = JSON.parse(rawJson);
    return SessionSummarySchema.parse(parsed);
  }

  const context = gatherGitContext();
  const userPrompt = `Git log (last 10 commits):\n${context.git_log}\n\nGit diff:\n${context.git_diff}`;

  const sessionId = uuidv4();
  const timestamp = new Date().toISOString();

  const systemWithIds = INGEST_SYSTEM.replace("<uuid>", sessionId).replace(
    "<ISO8601>",
    timestamp
  );

  const raw = await callClaude(client, systemWithIds, userPrompt);
  const cleaned = stripFences(raw);
  const parsed = JSON.parse(cleaned);

  if (!parsed.session_id) parsed.session_id = sessionId;
  if (!parsed.timestamp) parsed.timestamp = timestamp;

  return SessionSummarySchema.parse(parsed);
}
