import { v4 as uuidv4 } from "uuid";
import { LLMClient } from "../claude/types.js";
import { callClaude } from "../claude/client.js";
import { gatherGitContext, gatherStructuralContext, StructuralContext } from "../adapters/claude-code.js";
import { SessionSummary, SessionSummarySchema } from "../types/session.js";
import { CodeFacts } from "../types/code-facts.js";

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

const DIGEST_NOTE = `

The input includes a structural digest computed deterministically from the repository. It is complete: every changed file is listed, with the functions, classes, and types that were added, modified, renamed, moved, or removed. Ground the narrative in those entity names. Do not invent numbers; file, line, entity, and complexity counts are attached from the digest automatically after you answer, so any counts you write are overwritten.`;

/**
 * A small diff rides along with the digest (exact strings and error messages
 * help the narrative). A large one doesn't: the digest is the complete record,
 * and a partial diff would only spend tokens.
 */
export const RAW_DIFF_INLINE_MAX = 4_000;
/**
 * When the digest has no code entities to show (docs/config-only change, or
 * L0), a bounded excerpt is the only content signal the model gets.
 */
export const RAW_DIFF_EXCERPT_MAX = 6_000;

export function rawDiffSection(raw: string, hasEntities: boolean): string {
  if (raw.length <= RAW_DIFF_INLINE_MAX) return `\n\nRaw diff:\n${raw}`;
  if (hasEntities) return "";
  return `\n\nRaw diff excerpt (first ${RAW_DIFF_EXCERPT_MAX / 1000} KB of a larger change; the digest above lists every changed file):\n${raw.slice(0, RAW_DIFF_EXCERPT_MAX)}`;
}

export interface IngestOptions {
  /** Repository root for the git path (default: cwd). */
  root?: string;
  /** Git range for the git path: `A..B`, `A...B`, a commit; default HEAD~1..HEAD. */
  range?: string;
  /** JSON path only: also attach deterministic code facts from git for `range`. */
  withCodeFacts?: boolean;
}

function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  if (fenced) return fenced[1].trim();
  return text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();
}

/**
 * Attach code facts and make the size signals deterministic. The LLM's
 * estimates of files/lines/tests are replaced by measured values; only
 * `debugging_involved` (not visible in git) keeps the model's judgment.
 */
export function applyCodeFacts(session: SessionSummary, facts: CodeFacts): SessionSummary {
  const tests = facts.tests;
  session.summary.code_facts = facts;
  session.summary.complexity_signals = {
    ...session.summary.complexity_signals,
    files_touched: facts.files_changed,
    lines_changed: facts.lines_added + facts.lines_removed,
    test_coverage: tests ? tests.test_files_changed > 0 || tests.linked.length > 0 : undefined,
  };
  return session;
}

/**
 * The git-path ingest prompt. v3 sends the structural digest (complete) and,
 * for a small change, the raw diff; v2 — used when there is no repo or git
 * fails — sends the log plus the first 15 KB of the diff.
 */
export async function buildIngestPrompt(
  opts: IngestOptions,
  sessionId = "<uuid>",
  timestamp = "<ISO8601>"
): Promise<{ system: string; user: string; structural: StructuralContext | null }> {
  const structural = await gatherStructuralContext({ root: opts.root, range: opts.range });
  const system = INGEST_SYSTEM.replace("<uuid>", sessionId).replace("<ISO8601>", timestamp);
  if (!structural) {
    const context = gatherGitContext(opts.root);
    return {
      system,
      user: `Git log (last 10 commits):\n${context.git_log}\n\nGit diff:\n${context.git_diff}`,
      structural,
    };
  }

  const { digest, rendered } = structural;
  const commits = digest.subjects.slice(0, 20).join("\n") || "(no commit subjects)";
  const diff = opts.range
    ? ""
    : rawDiffSection(gatherGitContext(opts.root).git_diff, digest.facts.entity_changes.length > 0);
  return {
    system: system + DIGEST_NOTE,
    user: `Commits in range ${digest.range.label} (newest first):\n${commits}\n\n${rendered}${diff}`,
    structural,
  };
}

export async function ingestSession(
  client: LLMClient,
  rawJson?: string,
  opts: IngestOptions = {}
): Promise<SessionSummary> {
  if (rawJson) {
    const parsed = JSON.parse(rawJson);
    const session = SessionSummarySchema.parse(parsed);
    if (opts.withCodeFacts && !session.summary.code_facts) {
      const structural = await gatherStructuralContext({ root: opts.root, range: opts.range });
      if (structural) applyCodeFacts(session, structural.digest.facts);
    }
    return session;
  }

  const sessionId = uuidv4();
  const timestamp = new Date().toISOString();
  const { system, user, structural } = await buildIngestPrompt(opts, sessionId, timestamp);

  const raw = await callClaude(client, system, user);
  const cleaned = stripFences(raw);
  const parsed = JSON.parse(cleaned);

  if (!parsed.session_id) parsed.session_id = sessionId;
  if (!parsed.timestamp) parsed.timestamp = timestamp;

  const session = SessionSummarySchema.parse(parsed);
  return structural ? applyCodeFacts(session, structural.digest.facts) : session;
}
