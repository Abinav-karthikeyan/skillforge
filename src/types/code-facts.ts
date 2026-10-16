import { z } from "zod";

/**
 * Deterministic code facts (plan_v3 Pillar A). Computed from git plus, when the
 * codeintel companion is installed, tree-sitter ASTs. Translator prompts are
 * told that numbers and counts may only come from here, and the judge's
 * metric-honesty check treats these as ground truth.
 *
 *   layer   L0 = git only (line counts, hunk-header symbols)
 *           L1 = tree-sitter structure; name-based references are approximate
 *           L2 = LSP-backed (host-supplied); references are precise
 */
export const EntityKindSchema = z.enum([
  "function",
  "method",
  "class",
  "interface",
  "type",
  "enum",
  "struct",
  "trait",
  "module",
]);

export const EntityChangeKindSchema = z.enum(["added", "modified", "removed", "renamed", "moved"]);

export const EntityChangeSchema = z.object({
  path: z.string(),
  /** Qualified name, e.g. `RateLimiter.allow`. */
  symbol: z.string(),
  kind: EntityKindSchema,
  change: EntityChangeKindSchema,
  previous_symbol: z.string().optional(),
  previous_path: z.string().optional(),
  exported: z.boolean().optional(),
  signature_changed: z.boolean().optional(),
  complexity_before: z.number().int().optional(),
  complexity_after: z.number().int().optional(),
});

export const ChangeClassificationSchema = z.enum([
  "feature",
  "refactor",
  "fix",
  "test",
  "config",
  "docs",
  "mixed",
]);

export const FingerprintSchema = z.object({
  languages: z.array(z.string()).default([]),
  frameworks: z.array(z.string()).default([]),
  dependencies_added: z.array(z.string()).default([]),
  key_symbols: z.array(z.string()).default([]),
  patterns: z.array(z.string()).default([]),
});

export const BlastRadiusSchema = z.object({
  symbol: z.string(),
  path: z.string(),
  /** Files (other than the defining one) that mention the symbol. */
  referencing_files: z.number().int(),
  /** Name-based count (L1) — render as "~N". False only when LSP-backed. */
  approximate: z.boolean(),
});

export const CodeFactsSchema = z.object({
  layer: z.enum(["L0", "L1", "L2"]),
  source: z.enum(["git", "ast", "lsp"]),
  range: z.string(),
  files_changed: z.number().int(),
  lines_added: z.number().int(),
  lines_removed: z.number().int(),
  /** Changed files per language. */
  languages: z.record(z.string(), z.number().int()).default({}),
  classification: ChangeClassificationSchema,
  classification_reasons: z.array(z.string()).default([]),
  entities: z
    .object({
      added: z.number().int(),
      modified: z.number().int(),
      removed: z.number().int(),
      renamed: z.number().int(),
      moved: z.number().int(),
    })
    .optional(),
  /** The most significant entity changes; counts in `entities` are always complete. */
  entity_changes: z.array(EntityChangeSchema).default([]),
  entity_changes_omitted: z.number().int().optional(),
  complexity: z
    .object({
      /** Sum of cyclomatic complexity over the entities this change touched. */
      touched_before: z.number().int(),
      touched_after: z.number().int(),
    })
    .optional(),
  public_api: z
    .array(
      z.object({
        path: z.string(),
        symbol: z.string(),
        kind: EntityKindSchema,
        change: EntityChangeKindSchema,
      })
    )
    .default([]),
  tests: z
    .object({
      test_files_changed: z.number().int(),
      /** Test files that reference a changed symbol (name-based). */
      linked: z.array(z.object({ test_file: z.string(), symbols: z.array(z.string()) })).default([]),
    })
    .optional(),
  blast_radius: z.array(BlastRadiusSchema).default([]),
  /** Symbols named in diff hunk headers (L0 only). */
  hunk_symbols: z.array(z.string()).optional(),
  /** Line attribution from imported Agent Trace records for these commits (agent-trace.dev). */
  attribution: z
    .object({
      source: z.literal("agent-trace"),
      ai_lines: z.number().int(),
      human_lines: z.number().int(),
      mixed_lines: z.number().int(),
      unknown_lines: z.number().int(),
      tools: z.array(z.string()).default([]),
      models: z.array(z.string()).default([]),
      records: z.number().int(),
    })
    .optional(),
  fingerprint: FingerprintSchema.optional(),
});

export type CodeFacts = z.infer<typeof CodeFactsSchema>;
export type EntityKind = z.infer<typeof EntityKindSchema>;
export type EntityChange = z.infer<typeof EntityChangeSchema>;
export type EntityChangeKind = z.infer<typeof EntityChangeKindSchema>;
export type ChangeClassification = z.infer<typeof ChangeClassificationSchema>;
export type Fingerprint = z.infer<typeof FingerprintSchema>;
