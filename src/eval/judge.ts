import { z } from "zod";
import { LLMClient } from "../claude/types.js";
import { callClaude } from "../claude/client.js";
import { CalibrationConfig } from "../types/config.js";
import { SessionSummary, TranslationMode } from "../types/session.js";
import { interpolate, loadPrompt } from "../translators/base.js";
import { checkMetricHonesty, MetricHonestyReport } from "./metric-honesty.js";

/**
 * LLM-as-judge (v2 Bet 6, a v3 prerequisite). Every later phase claims to
 * "improve artifacts"; this is the score that has to move.
 *
 * Four dimensions come from a rubric prompt at temperature 0 (where the
 * provider allows it). Metric honesty is computed deterministically
 * (./metric-honesty.ts) so the most gameable dimension is also the most
 * reproducible one.
 */
export const JUDGE_DIMENSIONS = [
  "star_completeness",
  "specificity",
  "groundedness",
  "metric_honesty",
  "calibration_fit",
] as const;

export type JudgeDimension = (typeof JUDGE_DIMENSIONS)[number];

const DimSchema = z.object({
  score: z.number().min(1).max(5),
  rationale: z.string(),
});

const JudgeResponseSchema = z.object({
  star_completeness: DimSchema.nullable().optional(),
  specificity: DimSchema,
  groundedness: DimSchema.extend({
    unsupported_claims: z.array(z.string()).default([]),
  }),
  calibration_fit: DimSchema,
});

export interface JudgeScores {
  /** null for modes other than interview-qa. */
  star_completeness: number | null;
  specificity: number;
  groundedness: number;
  metric_honesty: number;
  calibration_fit: number;
}

export interface ComparisonReport {
  /** Sentences comparing the work with an external, named system. */
  external: number;
  /** Those without an evidence citation ([n] or [pa-…]). */
  uncited: string[];
}

const COMPARATIVE =
  /\b(unlike|similar(ly)? to|compared (to|with)|in contrast (to|with)|whereas|the way [A-Z][\w.-]+|like [A-Z][\w.-]+ (does|did)|as [A-Z][\w.-]+ does|same approach as|differs? from|instead of how)\b/i;
const CITED = /\[\d+\]|\[(pa|cal)-[a-z0-9-]+\]/;
const NOT_NAMES = new Set(["The", "This", "That", "These", "Those", "Our", "Their", "When", "While", "Instead", "Unlike", "Like", "Compared", "Whereas", "Situation", "Task", "Action", "Result", "Answer", "Calibration", "Sources", "Follow-ups"]);

/**
 * Deterministic check (plan_v3 §4.5): a comparison with a named external
 * system must cite an evidence entry. "External" = a capitalized name in a
 * comparative sentence that the session summary itself never mentions.
 */
export function checkComparisons(body: string, session: SessionSummary): ComparisonReport {
  const { evidence: _evidence, ...own } = session.summary;
  const ground = JSON.stringify(own).toLowerCase();
  const sentences = body.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  let external = 0;
  const uncited: string[] = [];
  for (const sentence of sentences) {
    if (!COMPARATIVE.test(sentence)) continue;
    const names = [...sentence.matchAll(/(?<![\w.])[A-Z][A-Za-z0-9.-]{2,}\b/g)]
      .map((m) => m[0].replace(/[.-]+$/, ""))
      .filter((n) => !NOT_NAMES.has(n) && !ground.includes(n.toLowerCase()));
    if (names.length === 0) continue;
    external++;
    if (!CITED.test(sentence)) uncited.push(sentence.slice(0, 200));
  }
  return { external, uncited };
}

export interface JudgeResult {
  mode: TranslationMode;
  prompt_version: string;
  scores: JudgeScores;
  /** Mean of the non-null dimension scores, two decimals. */
  overall: number;
  rationales: Partial<Record<JudgeDimension, string>>;
  unsupported_claims: string[];
  metric_honesty: MetricHonestyReport;
  comparisons: ComparisonReport;
}

export interface JudgeInput {
  mode: TranslationMode;
  /** The artifact body (translator output). Frontmatter/header are stripped if present. */
  artifact: string;
  session: SessionSummary;
  config: CalibrationConfig;
  promptVersion?: string;
  /** Additional ground truth for metric honesty (e.g. code facts). */
  extraGround?: unknown[];
}

function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();
}

/**
 * Reduce a rendered artifact file to the translator body: drop YAML
 * frontmatter and the renderer's `# Title … ---` header. A bare body passes
 * through unchanged.
 */
export function extractArtifactBody(markdown: string): string {
  let body = markdown.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  if (/^\s*# /.test(body)) {
    const sep = body.search(/\r?\n---\r?\n/);
    if (sep !== -1) body = body.slice(sep).replace(/^\r?\n---\r?\n/, "");
  }
  return body.trim();
}

/** Read the `mode:` field from an artifact's frontmatter, if any. */
export function modeFromFrontmatter(markdown: string): TranslationMode | undefined {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  const mode = fm ? /^mode:\s*(\S+)/m.exec(fm[1])?.[1] : undefined;
  return mode === "interview-qa" || mode === "portfolio-bullet" || mode === "technical-deep-dive"
    ? mode
    : undefined;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function judgeArtifact(client: LLMClient, input: JudgeInput): Promise<JudgeResult> {
  const body = extractArtifactBody(input.artifact);
  const { content: template, version } = loadPrompt("judge", input.promptVersion);
  const system = interpolate(template, {
    mode: input.mode,
    experience_level: input.config.experience_level,
    target_role: input.config.target_role ?? "(unspecified)",
    session_summary_json: JSON.stringify(input.session.summary, null, 2),
    artifact: body,
  });

  const ask = "Grade the artifact.";
  let raw = await callClaude(client, system, ask, { temperature: 0 });
  let parsed = JudgeResponseSchema.safeParse(safeJson(raw));
  if (!parsed.success) {
    // One corrective retry: judges occasionally wrap JSON in prose.
    raw = await callClaude(
      client,
      system,
      `${ask}\n\nYour previous reply was not valid JSON in the required shape. Return ONLY the JSON object.`,
      { temperature: 0 }
    );
    parsed = JudgeResponseSchema.safeParse(safeJson(raw));
  }
  if (!parsed.success) {
    throw new Error(`Judge returned an unparseable response: ${parsed.error.message.slice(0, 200)}`);
  }

  const judged = parsed.data;
  const metric = checkMetricHonesty(body, input.session, input.extraGround);
  const star = input.mode === "interview-qa" ? judged.star_completeness?.score ?? null : null;

  const comparisons = checkComparisons(body, input.session);
  const scores: JudgeScores = {
    star_completeness: star,
    specificity: judged.specificity.score,
    // An uncited comparison with an external system caps groundedness.
    groundedness: comparisons.uncited.length ? Math.min(judged.groundedness.score, 3) : judged.groundedness.score,
    metric_honesty: metric.score,
    calibration_fit: judged.calibration_fit.score,
  };
  const present = Object.values(scores).filter((s): s is number => s !== null);

  const rationales: JudgeResult["rationales"] = {
    specificity: judged.specificity.rationale,
    groundedness: judged.groundedness.rationale,
    calibration_fit: judged.calibration_fit.rationale,
    metric_honesty: metric.unsupported.length
      ? `Ungrounded numbers: ${metric.unsupported.join(", ")}`
      : `All ${metric.numbers_found.length} stated numbers are grounded.`,
  };
  if (star !== null && judged.star_completeness) {
    rationales.star_completeness = judged.star_completeness.rationale;
  }

  return {
    mode: input.mode,
    prompt_version: version,
    scores,
    overall: round2(present.reduce((a, b) => a + b, 0) / present.length),
    rationales,
    unsupported_claims: [...judged.groundedness.unsupported_claims, ...comparisons.uncited.map((s) => `uncited comparison: ${s}`)],
    metric_honesty: metric,
    comparisons,
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(stripFences(raw));
  } catch {
    return undefined;
  }
}

/** Render judge results as a markdown table — comparable across runs. */
export function formatJudgeTable(rows: Array<{ label: string; result: JudgeResult }>): string {
  const header = ["artifact", "STAR", "specific", "grounded", "metric", "calib", "overall"];
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
  for (const { label, result } of rows) {
    const s = result.scores;
    lines.push(
      `| ${label} | ${s.star_completeness ?? "–"} | ${s.specificity} | ${s.groundedness} | ` +
        `${s.metric_honesty} | ${s.calibration_fit} | **${result.overall}** |`
    );
  }
  return lines.join("\n");
}
