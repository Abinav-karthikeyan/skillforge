import Anthropic from "@anthropic-ai/sdk";
import {
  BUDGET_EXHAUSTED_NUDGE,
  ChatOptions,
  LLMClient,
  NativeToolCapability,
  NativeToolLoopResult,
  NativeToolLoopSpec,
} from "../types.js";
import { DEFAULT_MODELS } from "../models.js";

/** The slice of the SDK client this provider uses — injectable for tests. */
export interface AnthropicMessagesClient {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal }
    ): Promise<Anthropic.Message>;
  };
}

const DEFAULT_MAX_TOKENS = 4096;

/**
 * Current Claude models (Opus 4.7+, Sonnet 5+, Fable, Haiku 5.5) reject
 * non-default sampling parameters with a 400. Only the older generations
 * below accept `temperature`; for everything else it is dropped, and
 * determinism comes from the prompt and deterministic checks instead.
 */
function supportsSampling(model: string): boolean {
  return /^claude-(?:3|(?:opus|sonnet)-4-[0-6](?:\D|$)|haiku-4-5|(?:opus|sonnet)-4-\d{8})/.test(model);
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export class AnthropicProvider implements LLMClient {
  private client: AnthropicMessagesClient;
  private model: string;
  readonly nativeTools: NativeToolCapability;

  constructor(apiKey?: string, model: string = DEFAULT_MODELS.anthropic, sdkClient?: AnthropicMessagesClient) {
    if (sdkClient) {
      this.client = sdkClient;
    } else {
      const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!key) {
        throw new Error(
          "ANTHROPIC_API_KEY is not set.\nExport it before running skill-forge:\n  export ANTHROPIC_API_KEY=sk-ant-..."
        );
      }
      this.client = new Anthropic({ apiKey: key });
    }
    this.model = model;
    this.nativeTools = {
      protocol: "anthropic",
      runToolLoop: (spec) => this.runToolLoop(spec),
    };
  }

  async chat(system: string, user: string, opts: ChatOptions = {}): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.max_tokens ?? DEFAULT_MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
      ...(opts.temperature !== undefined && supportsSampling(this.model)
        ? { temperature: opts.temperature }
        : {}),
    });
    if (response.stop_reason === "refusal") {
      throw new Error("Anthropic declined the request (stop_reason: refusal)");
    }
    const text = textOf(response.content);
    if (!text) throw new Error("No text in Anthropic response");
    return text;
  }

  /**
   * Manual Messages-API tool loop. The loop is owned here (not the SDK's beta
   * tool runner) because the orchestrator needs a hard tool-call budget and a
   * wall-clock abort that both work the same way on the OpenAI path.
   *
   * Full `response.content` is echoed back each turn so thinking blocks stay
   * intact; once the budget is spent the next request sets
   * `tool_choice: none`, which every current model accepts (forced `any` /
   * `tool` choices are rejected by the newest ones).
   */
  private async runToolLoop(spec: NativeToolLoopSpec): Promise<NativeToolLoopResult> {
    const tools: Anthropic.Tool[] = spec.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.json_schema as Anthropic.Tool.InputSchema,
    }));
    const byName = new Map(spec.tools.map((t) => [t.name, t]));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: spec.user_prompt }];
    const usage = { input: 0, output: 0 };
    let calls = 0;
    let exhausted = spec.max_tool_calls <= 0;

    // Each non-final turn spends at least one tool call, so the budget bounds
    // the loop; the +2 covers the forced final turn.
    for (let turn = 0; turn < spec.max_tool_calls + 2; turn++) {
      spec.signal?.throwIfAborted();
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: Math.max(spec.max_output_tokens ?? 0, DEFAULT_MAX_TOKENS),
          system: spec.system_prompt,
          tools,
          tool_choice: exhausted ? { type: "none" } : { type: "auto" },
          messages,
        },
        { signal: spec.signal }
      );
      usage.input += response.usage?.input_tokens ?? 0;
      usage.output += response.usage?.output_tokens ?? 0;

      if (response.stop_reason === "refusal") {
        throw new Error("Anthropic declined the request (stop_reason: refusal)");
      }
      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        return { text: textOf(response.content), tool_calls: calls, tokens_used: usage };
      }

      messages.push({ role: "assistant", content: response.content });
      // Every tool_use block needs a tool_result in the next user turn, so
      // over-budget parallel calls get an error result rather than being dropped.
      const results: Array<Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam> = [];
      for (const use of toolUses) {
        if (calls >= spec.max_tool_calls) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: "error: tool budget exhausted",
            is_error: true,
          });
          continue;
        }
        calls++;
        const tool = byName.get(use.name);
        if (!tool) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: `error: unknown tool "${use.name}"`,
            is_error: true,
          });
          continue;
        }
        try {
          results.push({ type: "tool_result", tool_use_id: use.id, content: await tool.execute(use.input) });
        } catch (err) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: `error: ${(err as Error).message}`,
            is_error: true,
          });
        }
      }
      exhausted = calls >= spec.max_tool_calls;
      if (exhausted) results.push({ type: "text", text: BUDGET_EXHAUSTED_NUDGE });
      messages.push({ role: "user", content: results });
    }
    throw new Error("Anthropic tool loop did not produce a final answer");
  }
}
