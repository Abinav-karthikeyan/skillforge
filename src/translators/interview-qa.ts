import { z } from "zod";
import { LLMClient } from "../claude/types.js";
import { callClaude } from "../claude/client.js";
import { SessionSummary, TranslatorOutput } from "../types/session.js";
import { CalibrationConfig } from "../types/config.js";
import { loadPrompt, interpolate, applyCustomInstructions, applyCodeFactsRule, applyEvidenceRule } from "./base.js";
import { runFocusScout, renderFocusBlock, FocusRunResult } from "../orchestrator/focus.js";

const StarAnswerSchema = z.object({
  situation: z.string(),
  task: z.string(),
  action: z.string(),
  result: z.string(),
});

const QuestionSchema = z.object({
  question: z.string(),
  category: z.enum(["system-design", "behavioural", "debugging", "technical-depth"]),
  answer: StarAnswerSchema,
  follow_ups: z.array(z.string()),
  calibration_note: z.string(),
});

const InterviewQAResponseSchema = z.object({
  questions: z.array(QuestionSchema),
});

type InterviewQAResponse = z.infer<typeof InterviewQAResponseSchema>;
type Question = z.infer<typeof QuestionSchema>;

const CATEGORY_LABELS: Record<Question["category"], string> = {
  "system-design": "System Design",
  "behavioural": "Behavioural",
  "debugging": "Debugging",
  "technical-depth": "Technical Depth",
};

function renderQuestion(q: Question, index: number): string {
  const lines: string[] = [];

  lines.push(`## Q${index + 1} · ${CATEGORY_LABELS[q.category]}`);
  lines.push("");
  lines.push(`**${q.question}**`);
  lines.push("");

  lines.push("### Answer");
  lines.push("");
  lines.push(`**Situation** — ${q.answer.situation}`);
  lines.push("");
  lines.push(`**Task** — ${q.answer.task}`);
  lines.push("");
  lines.push(`**Action** — ${q.answer.action}`);
  lines.push("");
  lines.push(`**Result** — ${q.answer.result}`);
  lines.push("");

  lines.push("### Follow-ups to prepare for");
  lines.push("");
  for (const fu of q.follow_ups) {
    lines.push(`- ${fu}`);
  }
  lines.push("");

  lines.push("> **Calibration:** " + q.calibration_note);
  lines.push("");

  return lines.join("\n");
}

function renderInterviewQA(data: InterviewQAResponse): string {
  const sections = data.questions.map((q, i) => renderQuestion(q, i));
  return sections.join("---\n\n");
}

function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();
}

export interface InterviewQAOptions {
  promptVersion?: string;
  focusOverride?: string | string[];
}

export async function translateInterviewQA(
  client: LLMClient,
  session: SessionSummary,
  config: CalibrationConfig,
  optionsOrVersion?: string | InterviewQAOptions
): Promise<TranslatorOutput> {
  const opts: InterviewQAOptions =
    typeof optionsOrVersion === "string"
      ? { promptVersion: optionsOrVersion }
      : optionsOrVersion ?? {};

  const effectiveFocus = opts.focusOverride ?? config.focus;
  const { content: template, version } = loadPrompt("interview-qa", opts.promptVersion);

  let scoutResult: FocusRunResult = { brief: null, fallback_reason: "no-focus" };
  if (effectiveFocus) {
    scoutResult = await runFocusScout(client, session, effectiveFocus, config);
    if (scoutResult.fallback_reason && scoutResult.fallback_reason !== "no-focus") {
      // Surface degradations so users know the pipeline fell back rather than
      // silently ignoring their focus.
      console.warn(
        `[focus] scout fallback: ${scoutResult.fallback_reason}` +
          (scoutResult.elapsed_ms !== undefined ? ` (${scoutResult.elapsed_ms}ms)` : "")
      );
    }
  }

  const focusBlock = renderFocusBlock(scoutResult.brief, effectiveFocus);

  const basePrompt = interpolate(template, {
    experience_level: config.experience_level,
    session_summary_json: JSON.stringify(session.summary, null, 2),
    focus_brief_block: focusBlock,
  });
  const systemPrompt = applyEvidenceRule(
    applyCodeFactsRule(applyCustomInstructions(basePrompt, config, "interview-qa"), session),
    session
  );

  const raw = await callClaude(client, systemPrompt, "Generate the interview Q&A.");
  const parsed = InterviewQAResponseSchema.parse(JSON.parse(stripFences(raw)));
  const content = renderInterviewQA(parsed);

  return {
    mode: "interview-qa",
    session_id: session.session_id,
    timestamp: new Date().toISOString(),
    content,
    prompt_version: version,
  };
}
