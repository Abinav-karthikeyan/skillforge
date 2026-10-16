import { z } from "zod";
import {
  SessionSummary,
  SessionSummaryContentSchema,
  SESSION_SUMMARY_SCHEMA_VERSION,
} from "./session.js";

/**
 * Data model v2 (plan_v3.md §5): Event → Observation → Story → Artifact(version),
 * with Evidence (./evidence.ts) carrying provenance at every step.
 *
 * `SessionSummary` survives as a *projection* of a Story (`projectStory`), so
 * the existing translators keep working unchanged.
 */

// ── Hot path: normalized host events ──────────────────────────────────────
export const ObservedEventKindSchema = z.enum([
  "prompt",
  "tool_call",
  "tool_result",
  "file_edit",
  "test_run",
  "commit",
  "compaction",
  "session_start",
  "session_end",
]);

export const TranscriptRefSchema = z.object({
  path: z.string(),
  offset: z.number().int().min(0),
  length: z.number().int().min(0),
});

export const ObservedEventSchema = z.object({
  id: z.string(),
  host: z.string(),
  session_id: z.string(),
  agent_id: z.string().optional(),
  ts: z.string(),
  kind: ObservedEventKindSchema,
  payload: z.record(z.string(), z.unknown()).optional(),
  transcript_ref: TranscriptRefSchema.optional(),
  // Capture redacts before persisting; the literal makes an unredacted event
  // unrepresentable in the journal.
  redacted: z.literal(true),
});

// ── Warm path: claim-sized observations ───────────────────────────────────
export const ObservationKindSchema = z.enum([
  "tradeoff",
  "dead_end",
  "debug_arc",
  "decision",
  "milestone",
  "learning",
]);

export const ObservationSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  kind: ObservationKindSchema,
  claim: z.string(),
  evidence_ids: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  ts: z.string(),
});

// ── Cold path: stories and their artifact versions ────────────────────────
export const StoryStatusSchema = z.enum(["candidate", "approved", "discarded"]);

export const StoryArtifactSchema = z.object({
  mode: z.string(),
  file: z.string(),
  version: z.number().int().min(1),
  prompt_version: z.string().optional(),
  written_at: z.string(),
});

export const StoryOriginSchema = z.enum(["generate", "observer", "legacy-index"]);

export const StorySchema = z.object({
  story_id: z.string(),
  title: z.string(),
  status: StoryStatusSchema,
  version: z.number().int().min(1),
  created_at: z.string(),
  updated_at: z.string(),
  origin: StoryOriginSchema.default("generate"),
  source_tool: z.string().default("claude-code"),
  session_ids: z.array(z.string()).default([]),
  observation_ids: z.array(z.string()).default([]),
  evidence_ids: z.array(z.string()).default([]),
  // The distilled content the story projects into a SessionSummary. Absent
  // for stories migrated from a legacy index.yml (only the one_liner survives).
  summary: SessionSummaryContentSchema.optional(),
  // Deterministic code facts (Pillar A). Typed in src/codeintel once it lands.
  code_facts: z.unknown().optional(),
  artifacts: z.array(StoryArtifactSchema).default([]),
});

export type ObservedEvent = z.infer<typeof ObservedEventSchema>;
export type ObservedEventKind = z.infer<typeof ObservedEventKindSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type ObservationKind = z.infer<typeof ObservationKindSchema>;
export type Story = z.infer<typeof StorySchema>;
export type StoryStatus = z.infer<typeof StoryStatusSchema>;
export type StoryArtifact = z.infer<typeof StoryArtifactSchema>;

/**
 * Project a Story into the v1 SessionSummary shape (+ schema_version) so the
 * translators render it unchanged. A legacy story with no stored summary
 * projects to a thin summary built from its title — enough to re-render, but
 * callers should prefer stories that carry a real summary.
 */
export function projectStory(story: Story): SessionSummary {
  const summary = story.summary ?? {
    one_liner: story.title,
    problem_statement: "",
    approach: "",
    tradeoffs: [],
    dead_ends: [],
    technologies: [],
    patterns_used: [],
  };
  return {
    schema_version: SESSION_SUMMARY_SCHEMA_VERSION,
    session_id: story.session_ids[story.session_ids.length - 1] ?? story.story_id,
    story_id: story.story_id,
    timestamp: story.updated_at,
    source_tool: story.source_tool,
    summary,
  };
}
