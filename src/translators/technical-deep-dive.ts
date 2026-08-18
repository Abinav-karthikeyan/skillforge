import { LLMClient } from "../claude/types.js";
import { callClaude } from "../claude/client.js";
import { SessionSummary, TranslatorOutput } from "../types/session.js";
import { CalibrationConfig } from "../types/config.js";
import { loadPrompt, interpolate, applyCustomInstructions } from "./base.js";

export async function translateTechnicalDeepDive(
  client: LLMClient,
  session: SessionSummary,
  config: CalibrationConfig,
  promptVersion?: string
): Promise<TranslatorOutput> {
  const { content: template, version } = loadPrompt("technical-deepdive", promptVersion);
  const basePrompt = interpolate(template, {
    experience_level: config.experience_level,
    session_summary_json: JSON.stringify(session.summary, null, 2),
  });
  const systemPrompt = applyCustomInstructions(basePrompt, config, "technical-deep-dive");

  const content = await callClaude(client, systemPrompt, "Generate the technical deep-dive questions.");

  return {
    mode: "technical-deep-dive",
    session_id: session.session_id,
    timestamp: new Date().toISOString(),
    content,
    prompt_version: version,
  };
}
