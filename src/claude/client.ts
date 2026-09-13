import { LLMClient, ProviderName } from "./types.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { DEFAULT_MODELS } from "./models.js";

export interface ProviderConfig {
  provider?: ProviderName;
  model?: string;
  base_url?: string;
  api_key?: string;
}

const OLLAMA_BASE_URL = "http://localhost:11434/v1";

export function createClient(config: ProviderConfig = {}): LLMClient {
  const provider = config.provider ?? inferProviderFromEnv();

  switch (provider) {
    case "anthropic":
      return new AnthropicProvider(config.api_key, config.model);

    case "ollama":
      return new OpenAICompatibleProvider({
        baseURL: config.base_url ?? OLLAMA_BASE_URL,
        model: config.model ?? DEFAULT_MODELS.ollama,
        apiKey: "ollama",
      });

    case "openai":
      return new OpenAICompatibleProvider({
        model: config.model ?? DEFAULT_MODELS.openai,
        apiKey: config.api_key ?? process.env.OPENAI_API_KEY,
      });

    case "openai-compatible":
      return new OpenAICompatibleProvider({
        baseURL: config.base_url,
        model: config.model,
        apiKey: config.api_key ?? process.env.OPENAI_API_KEY,
      });

    default:
      throw new Error(
        `Unknown provider "${provider}". Valid options: anthropic, openai, ollama, openai-compatible`
      );
  }
}

function inferProviderFromEnv(): ProviderName {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  // Fall back to Ollama — local, no key needed
  return "ollama";
}

// Kept for backward-compat with any direct callers
export async function callClaude(
  client: LLMClient,
  system: string,
  user: string
): Promise<string> {
  return client.chat(system, user);
}
