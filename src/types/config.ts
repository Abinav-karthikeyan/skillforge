import { ProviderName } from "../claude/types.js";

/**
 * Free-form instructions appended to every translator system prompt.
 * Use a plain string to apply to all modes, or a keyed object to target
 * specific modes (plus an optional "global" key that always applies).
 *
 * Examples:
 *   custom_instructions: "I target Staff Engineer roles at fintech companies."
 *
 *   custom_instructions:
 *     global: "Emphasize reliability, distributed systems, and compliance angles."
 *     interview-qa: "Weight leadership and cross-team influence stories more heavily."
 *     portfolio-bullet: "Lead with business-impact metrics wherever inferable."
 */
export type CustomInstructions =
  | string
  | Partial<Record<"global" | "interview-qa" | "portfolio-bullet" | "technical-deep-dive", string>>;

export interface CalibrationConfig {
  experience_level: "junior" | "mid" | "senior" | "staff";
  target_role?: string;
  company_size?: "startup" | "mid" | "enterprise";
  tone?: "technical" | "business" | "balanced";
  output_dir?: string;
  default_mode?: "interview-qa" | "portfolio-bullet" | "technical-deep-dive";
  // LLM provider settings
  provider?: ProviderName;
  model?: string;
  base_url?: string;
  api_key?: string;
  // Output connector settings
  connector?: string;
  gist_token?: string;
  gist_public?: boolean;
  // Notion connector settings
  notion_token?: string;
  notion_database_id?: string;
  notion_property_map?: Record<string, string>;
  // Custom instructions injected into every translator prompt
  custom_instructions?: CustomInstructions;
  // Focus subagent — interview-qa only. `focus` is the user's lens ("system-design tradeoffs",
  // "cross-team influence"). `focus_effort` gates how much budget the orchestrator gives the
  // pre-translator brief call. `focus_deadline_ms` is a wall-clock safety net; on timeout the
  // pipeline falls back to plain string injection so generation never blocks.
  focus?: string | string[];
  focus_effort?: FocusEffort;
  focus_deadline_ms?: number;
  // Which subagent runtime to use for orchestrator-spawned turns (currently
  // only the focus scout). "auto" and unknown values resolve to the inline
  // runtime; "claude-sdk" / "openai-agents" are reserved for SDK-backed
  // implementations that will register in src/orchestrator/subagent/factory.ts.
  subagent_runtime?: SubagentRuntimeSelection;
}

export type FocusEffort = "low" | "medium" | "off";
export type SubagentRuntimeSelection = "auto" | "inline" | "claude-sdk" | "openai-agents";

export const DEFAULT_CALIBRATION: CalibrationConfig = {
  experience_level: "senior",
  tone: "balanced",
  output_dir: "~/.career-mode/artifacts",
};
