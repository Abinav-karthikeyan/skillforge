import { z } from "zod";

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
});

export const SessionSummarySchema = z.object({
  session_id: z.string(),
  timestamp: z.string(),
  duration_minutes: z.number().optional(),
  source_tool: z.string().default("claude-code"),
  summary: SessionSummaryContentSchema,
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type TradeoffEntry = z.infer<typeof TradeoffSchema>;

export type TranslationMode =
  | "interview-qa"
  | "portfolio-bullet"
  | "technical-deep-dive";

export interface TranslatorOutput {
  mode: TranslationMode;
  session_id: string;
  timestamp: string;
  content: string;
  prompt_version?: string;
}
