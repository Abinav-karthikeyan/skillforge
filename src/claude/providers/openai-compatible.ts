import OpenAI from "openai";
import { LLMClient } from "../types.js";

interface OpenAICompatibleOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

/**
 * Covers OpenAI, Ollama (baseURL=http://localhost:11434/v1, no key),
 * Groq, Together, LM Studio, and any OpenAI-compatible endpoint.
 */
export class OpenAICompatibleProvider implements LLMClient {
  private client: OpenAI;
  private model: string;

  constructor(opts: OpenAICompatibleOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "ollama";
    this.client = new OpenAI({
      apiKey,
      baseURL: opts.baseURL,
    });
    this.model = opts.model ?? "gpt-4o-mini";
  }

  async chat(system: string, user: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error("No text in OpenAI-compatible response");
    return text;
  }
}
