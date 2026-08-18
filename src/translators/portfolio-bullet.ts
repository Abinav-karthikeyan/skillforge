import { LLMClient } from "../claude/types.js";
import { callClaude } from "../claude/client.js";
import { SessionSummary, TranslatorOutput } from "../types/session.js";
import { CalibrationConfig } from "../types/config.js";
import { loadPrompt, interpolate, applyCustomInstructions } from "./base.js";

export async function translatePortfolioBullet(
  client: LLMClient,
  session: SessionSummary,
  config: CalibrationConfig,
  promptVersion?: string
): Promise<TranslatorOutput> {
  const { content: template, version } = loadPrompt("portfolio-bullet", promptVersion);
  const basePrompt = interpolate(template, {
    experience_level: config.experience_level,
    session_summary_json: JSON.stringify(session.summary, null, 2),
  });
  const systemPrompt = applyCustomInstructions(basePrompt, config, "portfolio-bullet");

  const content = await callClaude(client, systemPrompt, "Generate the portfolio bullets.");

  return {
    mode: "portfolio-bullet",
    session_id: session.session_id,
    timestamp: new Date().toISOString(),
    content,
    prompt_version: version,
  };
}
