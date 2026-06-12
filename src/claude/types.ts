export interface LLMClient {
  chat(system: string, user: string): Promise<string>;
}

export type ProviderName = "anthropic" | "openai" | "ollama" | "openai-compatible";
