import { z } from "zod";
import { callClaude } from "../claude/client.js";
import { LLMClient } from "../claude/types.js";
import { interpolate, loadPrompt } from "../translators/base.js";
import { safeJson } from "../observer/llm.js";
import { looksInjected, sanitizeUntrusted, stripUrls } from "./sanitize.js";

/**
 * The quarantined summarizer (plan_v3 §4.3, dual-LLM pattern). It is the
 * only model that ever sees raw repository text, it has no tools, and its
 * output is a constrained schema validated here before anything privileged
 * (the calibration scout, the translators) sees it:
 *
 *   - approach_summary ≤ 300 chars, no URLs, no injection markers
 *   - no 60-char run copied from the source (paraphrase only — never paste
 *     external code or prose into an artifact)
 *   - pattern names short and plain
 *
 * A summary that fails validation is dropped, not repaired.
 */
export interface QuarantinedSummary {
  approach_summary: string;
  patterns: string[];
  relevance: number;
}

const ResponseSchema = z.object({
  approach_summary: z.string(),
  patterns: z.array(z.string()).default([]),
  relevance: z.number(),
});

const MAX_SUMMARY = 300;

/** True when `summary` contains a ≥`window`-char run copied from `source`. */
export function copiesSource(summary: string, source: string, window = 60): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
  const a = norm(summary);
  const b = norm(source);
  for (let i = 0; i + window <= a.length; i += 10) {
    if (b.includes(a.slice(i, i + window))) return true;
  }
  return false;
}

export function validateSummary(raw: unknown, source: string): QuarantinedSummary | null {
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  let summary = stripUrls(parsed.data.approach_summary.replace(/\s+/g, " ").trim());
  // Too short to describe an approach, or far over budget: not following the contract.
  if (summary.length < 20 || summary.length > MAX_SUMMARY + 100) return null;
  if (summary.length > MAX_SUMMARY) summary = summary.slice(0, MAX_SUMMARY - 1).replace(/\s+\S*$/, "") + "…";
  if (looksInjected(summary) || copiesSource(summary, source)) return null;
  const patterns = parsed.data.patterns
    .map((p) => p.trim())
    .filter((p) => p.length > 1 && p.length <= 40 && /^[\w .+#/()-]+$/.test(p) && !looksInjected(p))
    .slice(0, 5);
  const relevance = Math.min(1, Math.max(0, parsed.data.relevance));
  return { approach_summary: summary, patterns, relevance };
}

export async function quarantinedSummarize(
  client: LLMClient,
  input: { repo: string; problem: string; content: string }
): Promise<QuarantinedSummary | null> {
  const content = sanitizeUntrusted(input.content);
  if (!content) return null;
  const { content: template } = loadPrompt("quarantine");
  const system = interpolate(template, { repo: input.repo, problem: input.problem, content });
  try {
    return validateSummary(safeJson(await callClaude(client, system, "Summarize the repository's approach.")), content);
  } catch {
    return null;
  }
}
