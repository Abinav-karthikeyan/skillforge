import { ProviderName } from "../claude/types.js";

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
  connector?: "local" | "gist";
  gist_token?: string; // falls back to GITHUB_TOKEN env
  gist_public?: boolean; // default false (secret gist)
}

export const DEFAULT_CALIBRATION: CalibrationConfig = {
  experience_level: "senior",
  tone: "balanced",
  output_dir: "~/.career-mode/artifacts",
};
