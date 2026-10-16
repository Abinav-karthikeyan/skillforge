import { z } from "zod";

/**
 * Evidence — one piece of provenance an artifact claim can cite. Every number
 * or comparison skill-forge renders should trace back to one of these: a
 * journal event, a commit SHA, a deterministic code fact, or an external
 * (prior-art / calibration) source pinned to a URL + SHA.
 *
 * Leaf module (depends on zod only) so both the SessionSummary schema and the
 * story ledger can import it without a cycle.
 */
export const EvidenceKindSchema = z.enum([
  "event",
  "commit",
  "code_fact",
  "prior_art",
  "calibration",
  "contribution",
  "gap",
]);

export const EvidenceSourceSchema = z.object({
  provider: z.string(),
  url: z.string().optional(),
  repo: z.string().optional(),
  sha: z.string().optional(),
  path: z.string().optional(),
  symbol: z.string().optional(),
  license: z.string().optional(),
  retrieved_at: z.string(),
});

export const EvidenceSchema = z.object({
  id: z.string(),
  kind: EvidenceKindSchema,
  source: EvidenceSourceSchema,
  summary: z.string(),
  /** True when the fact is name-based / heuristic (e.g. tree-sitter references without LSP). */
  approximate: z.boolean().optional(),
  confidence: z.number().min(0).max(1),
});

export type Evidence = z.infer<typeof EvidenceSchema>;
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;
