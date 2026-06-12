import { LLMClient } from "../claude/types.js";
import { callClaude } from "../claude/client.js";
import { SessionSummary, TranslatorOutput } from "../types/session.js";
import { CalibrationConfig } from "../types/config.js";
import { loadPrompt, interpolate } from "./base.js";

export async function translatePortfolioBullet(
  client: LLMClient,
  session: SessionSummary,
  config: CalibrationConfig
): Promise<TranslatorOutput> {
  const template = loadPrompt("portfolio-bullet");
  const systemPrompt = interpolate(template, {
    experience_level: config.experience_level,
    session_summary_json: JSON.stringify(session.summary, null, 2),
  });

  const content = await callClaude(client, systemPrompt, "Generate the portfolio bullets.");

  return {
    mode: "portfolio-bullet",
    session_id: session.session_id,
    timestamp: new Date().toISOString(),
    content,
  };
}
