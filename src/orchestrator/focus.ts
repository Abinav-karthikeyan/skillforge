import { z } from "zod";
import { LLMClient } from "../claude/types.js";
import { SessionSummary } from "../types/session.js";
import { CalibrationConfig, FocusEffort } from "../types/config.js";
import { loadPrompt, interpolate } from "../translators/base.js";
import { SubagentRuntime, SUBAGENT_TIMEOUT_MESSAGE } from "./subagent/types.js";
import { createSubagentRuntime } from "./subagent/factory.js";
import { buildScoutTools } from "./subagent/tools/registry.js";
import { ToolDef } from "./subagent/tools/types.js";
import { promptVersionFromEnv } from "../config/paths.js";

// ── Budget table ───────────────────────────────────────────────────────────
// Naive char-based token estimate (~4 chars/token). Kept in-house to avoid a
// tokenizer dep; good enough for a soft cap. `max_session_chars` truncates
// the session JSON we hand to the scout so a huge session cannot balloon the
// subagent call past the effort tier. `max_output_tokens` / `max_tool_calls`
// are hints the runtime enforces when it can (SDK-backed runtimes will;
// InlineRuntime cannot).
interface BudgetTier {
  max_session_chars: number;
  deadline_ms: number;
  max_output_tokens: number;
  max_tool_calls: number;
  label: string;
}

const BUDGETS: Record<Exclude<FocusEffort, "off">, BudgetTier> = {
  low:    { max_session_chars: 6_000,  deadline_ms: 15_000, max_output_tokens:  800, max_tool_calls: 0, label: "low" },
  medium: { max_session_chars: 20_000, deadline_ms: 30_000, max_output_tokens: 2000, max_tool_calls: 3, label: "medium" },
};

// ── Schema returned by the scout ──────────────────────────────────────────
const CategoryWeightsSchema = z.object({
  "system-design": z.number().min(0).max(1),
  "behavioural": z.number().min(0).max(1),
  "debugging": z.number().min(0).max(1),
  "technical-depth": z.number().min(0).max(1),
});

const FocusBriefSchema = z.object({
  relevant_signals: z.array(z.string()),
  gaps_to_probe: z.array(z.string()),
  category_weights: CategoryWeightsSchema,
  emphasis_notes: z.string(),
});

export type FocusBrief = z.infer<typeof FocusBriefSchema>;

export interface FocusRunResult {
  brief: FocusBrief | null;
  fallback_reason?: "no-focus" | "effort-off" | "timeout" | "parse-error" | "provider-error";
  effort_used?: string;
  runtime_used?: string;
  elapsed_ms?: number;
}

function normalizeFocus(focus: string | string[] | undefined): string | null {
  if (!focus) return null;
  const parts = Array.isArray(focus) ? focus : [focus];
  const joined = parts.map((p) => p.trim()).filter(Boolean).join("\n- ");
  return joined ? `- ${joined}` : null;
}

function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();
}

function truncateSession(session: SessionSummary, maxChars: number): string {
  const full = JSON.stringify(session.summary, null, 2);
  if (full.length <= maxChars) return full;
  return full.slice(0, maxChars) + "\n\n/* …truncated by focus-orchestrator budget… */";
}

export interface RunFocusScoutOptions {
  effort?: FocusEffort;
  deadlineMsOverride?: number;
  /** Explicit runtime injection — takes precedence over the config-driven factory. */
  runtime?: SubagentRuntime;
}

/**
 * Runs the focus subagent under a token/time budget and returns a structured
 * brief the interview-qa translator can consume. Never throws — a failed
 * scout call degrades gracefully to `{ brief: null, fallback_reason }` so the
 * main pipeline can keep going with plain-text focus injection.
 *
 * The conductor's job here is (1) pick the budget tier from `effort`,
 * (2) prepare a bounded SubagentSpec (input truncation, deadline, output/tool
 * caps as hints), (3) hand it to the SubagentRuntime, (4) validate the JSON
 * response into a FocusBrief. The runtime itself is a seam — InlineRuntime
 * today, SDK-backed implementations later — so this function does not change
 * when new runtimes are added.
 */
export async function runFocusScout(
  client: LLMClient,
  session: SessionSummary,
  focus: string | string[] | undefined,
  configOrEffort: CalibrationConfig | FocusEffort = "low",
  options: RunFocusScoutOptions = {}
): Promise<FocusRunResult> {
  // Back-compat: earlier callers passed a bare FocusEffort as the 4th arg
  // and a deadline number as the 5th. Normalize both call shapes here.
  const config: CalibrationConfig | null =
    typeof configOrEffort === "string" ? null : configOrEffort;
  const effort: FocusEffort =
    options.effort ??
    (typeof configOrEffort === "string" ? configOrEffort : configOrEffort.focus_effort) ??
    "low";
  const deadlineMsOverride =
    options.deadlineMsOverride ?? config?.focus_deadline_ms;

  const focusText = normalizeFocus(focus);
  if (!focusText) return { brief: null, fallback_reason: "no-focus" };
  if (effort === "off") return { brief: null, fallback_reason: "effort-off" };

  const budget = BUDGETS[effort];
  const deadline = deadlineMsOverride ?? budget.deadline_ms;
  const started = Date.now();

  const runtime =
    options.runtime ??
    createSubagentRuntime(client, config ?? ({} as CalibrationConfig));

  // Grant repo tools only when the tier actually spends tool calls. The v2
  // focus-brief prompt teaches the model the JSON tool-call protocol, so we
  // pick v2 whenever tools are in play and v1 for the single-shot path.
  // Explicit CAREER_MODE_PROMPT_VERSION overrides both.
  const wantsTools = budget.max_tool_calls > 0;
  const tools: ToolDef[] = wantsTools ? buildScoutTools() : [];
  const promptVersion = promptVersionFromEnv()
    ? undefined
    : wantsTools
      ? "v2"
      : "v1";

  const { content: template } = loadPrompt("focus-brief", promptVersion);
  const systemPrompt = interpolate(template, {
    focus: focusText,
    session_summary_json: truncateSession(session, budget.max_session_chars),
  });

  const userPrompt = wantsTools
    ? "Produce the focus brief. Call tools first if repo evidence would sharpen it, then emit `final`."
    : "Emit the focus brief JSON.";

  let raw: string;
  try {
    const result = await runtime.run({
      system_prompt: systemPrompt,
      user_prompt: userPrompt,
      deadline_ms: deadline,
      max_output_tokens: budget.max_output_tokens,
      max_tool_calls: budget.max_tool_calls,
      tools,
    });
    raw = result.text;
  } catch (err) {
    const reason =
      (err as Error).message === SUBAGENT_TIMEOUT_MESSAGE ? "timeout" : "provider-error";
    return {
      brief: null,
      fallback_reason: reason,
      effort_used: budget.label,
      runtime_used: runtime.name,
      elapsed_ms: Date.now() - started,
    };
  }

  try {
    const brief = FocusBriefSchema.parse(JSON.parse(stripFences(raw)));
    return {
      brief,
      effort_used: budget.label,
      runtime_used: runtime.name,
      elapsed_ms: Date.now() - started,
    };
  } catch {
    return {
      brief: null,
      fallback_reason: "parse-error",
      effort_used: budget.label,
      runtime_used: runtime.name,
      elapsed_ms: Date.now() - started,
    };
  }
}

/**
 * Renders a FocusBrief into the block the interview-qa v2 prompt expects at
 * the `{focus_brief_block}` slot. Returns a plain-text fallback when the
 * scout failed but the user still supplied a raw focus lens — that way the
 * downstream prompt at least sees the user's intent as free text.
 */
export function renderFocusBlock(
  brief: FocusBrief | null,
  rawFocus: string | string[] | undefined
): string {
  if (brief) {
    return [
      "```json",
      JSON.stringify(brief, null, 2),
      "```",
    ].join("\n");
  }
  const focusText = normalizeFocus(rawFocus);
  if (!focusText) return "(none)";
  return [
    "(scout unavailable — raw user focus follows; treat as advisory)",
    focusText,
  ].join("\n");
}
