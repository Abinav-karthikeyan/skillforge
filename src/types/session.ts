import { z } from "zod";
import { EvidenceSchema } from "./evidence.js";
import { CodeFactsSchema } from "./code-facts.js";

export const TradeoffSchema = z.object({
  decision: z.string(),
  reasoning: z.string(),
  alternative_considered: z.string(),
});

export const ComplexitySignalsSchema = z.object({
  files_touched: z.number().optional(),
  lines_changed: z.number().optional(),
  test_coverage: z.boolean().optional(),
  debugging_involved: z.boolean().optional(),
});

export const SessionSummaryContentSchema = z.object({
  one_liner: z.string(),
  problem_statement: z.string(),
  approach: z.string(),
  tradeoffs: z.array(TradeoffSchema).optional().default([]),
  dead_ends: z.array(z.string()).optional().default([]),
  technologies: z.array(z.string()).optional().default([]),
  patterns_used: z.array(z.string()).optional().default([]),
  complexity_signals: ComplexitySignalsSchema.optional(),
  // Deterministic code facts (v3 Pillar A) — the only allowed source of
  // numbers in artifacts when present. See src/types/code-facts.ts.
  code_facts: CodeFactsSchema.optional(),
  // Provenance the translators may cite (v3). No default, so a v1 summary
  // serializes into prompts byte-for-byte as before.
  evidence: z.array(EvidenceSchema).optional(),
});

/**
 * Current SessionSummary shape version. v1 summaries omit the field; a
 * summary projected from a Story (src/ledger) carries 2.
 */
export const SESSION_SUMMARY_SCHEMA_VERSION = 2;

export const SessionSummarySchema = z.object({
  schema_version: z.number().int().optional(),
  session_id: z.string(),
  // Living-artifact key: when set, connectors upsert by (story_id, mode)
  // instead of appending, and the story ledger versions the artifact.
  story_id: z.string().optional(),
  timestamp: z.string(),
  duration_minutes: z.number().optional(),
  source_tool: z.string().default("claude-code"),
  summary: SessionSummaryContentSchema,
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type SessionSummaryContent = z.infer<typeof SessionSummaryContentSchema>;
export type TradeoffEntry = z.infer<typeof TradeoffSchema>;

export type TranslationMode =
  | "interview-qa"
  | "portfolio-bullet"
  | "technical-deep-dive"
  // Composite artifacts (v3 Phase 3.5): not translator modes, but they travel
  // through the same connectors and index.
  | "jd-tailoring"
  | "weekly-digest";

export interface TranslatorOutput {
  mode: TranslationMode;
  session_id: string;
  timestamp: string;
  content: string;
  prompt_version?: string;
  /**
   * Artifact version, stamped by the local connector when it upserts a
   * story-keyed artifact. Unset for append-only (story-less) writes.
   */
  artifact_version?: number;
}
