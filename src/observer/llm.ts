import { createClient, inferProviderFromEnv, ProviderConfig } from "../claude/client.js";
import { CHEAP_MODELS } from "../claude/models.js";
import { LLMClient } from "../claude/types.js";
import { CalibrationConfig } from "../types/config.js";

/**
 * The model the observer and reflector run on (plan_v3 §10 decision 3):
 * `observer_model` if set, else the configured provider's cheap tier.
 * Confidential repositories always run on a local Ollama model, whatever the
 * main provider is — their content never leaves the machine.
 */
export function createObserverClient(config: CalibrationConfig, confidential: boolean): LLMClient {
  if (confidential) {
    return createClient({ provider: "ollama", model: config.observer_local_model ?? CHEAP_MODELS.ollama });
  }
  const provider = config.provider ?? inferProviderFromEnv();
  const cheap =
    provider === "anthropic" ? CHEAP_MODELS.anthropic : provider === "openai" ? CHEAP_MODELS.openai : config.model;
  return createClient({
    provider,
    model: config.observer_model ?? cheap ?? config.model,
    base_url: config.base_url,
    api_key: config.api_key,
  } as ProviderConfig);
}

export const CONFIDENTIAL_BLOCK = `
CONFIDENTIAL REPOSITORY: abstract proprietary names. Replace internal service, product, customer, team, and repository names with generic descriptions ("the billing service", "an internal analytics API"). Keep open-source library, language, and protocol names.
`;

export function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  if (fenced) return fenced[1].trim();
  return text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(stripFences(text));
  } catch {
    return undefined;
  }
}
