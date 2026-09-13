import Anthropic from "@anthropic-ai/sdk";
import { LLMClient } from "../types.js";
import { DEFAULT_MODELS } from "../models.js";

export class AnthropicProvider implements LLMClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey?: string, model: string = DEFAULT_MODELS.anthropic) {
    const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set.\nExport it before running career-mode:\n  export ANTHROPIC_API_KEY=sk-ant-..."
      );
    }
    this.client = new Anthropic({ apiKey: key });
    this.model = model;
  }

  async chat(system: string, user: string): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: user }],
    });
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("No text in Anthropic response");
    return block.text;
  }
}
