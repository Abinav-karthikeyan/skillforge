import OpenAI from "openai";
import {
  BUDGET_EXHAUSTED_NUDGE,
  ChatOptions,
  LLMClient,
  NativeToolCapability,
  NativeToolLoopResult,
  NativeToolLoopSpec,
} from "../types.js";

/** The slice of the SDK client this provider uses — injectable for tests. */
export interface OpenAIChatClient {
  chat: {
    completions: {
      create(
        body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        options?: { signal?: AbortSignal }
      ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
    };
  };
}

interface OpenAICompatibleOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  client?: OpenAIChatClient;
}

const DEFAULT_MAX_TOKENS = 4096;

/**
 * Covers OpenAI, Ollama (baseURL=http://localhost:11434/v1, no key),
 * Groq, Together, LM Studio, and any OpenAI-compatible endpoint.
 */
export class OpenAICompatibleProvider implements LLMClient {
  private client: OpenAIChatClient;
  private model: string;
  readonly nativeTools: NativeToolCapability;

  constructor(opts: OpenAICompatibleOptions = {}) {
    if (opts.client) {
      this.client = opts.client;
    } else {
      const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "ollama";
      this.client = new OpenAI({
        apiKey,
        baseURL: opts.baseURL,
      });
    }
    this.model = opts.model ?? "gpt-4o-mini";
    this.nativeTools = {
      protocol: "openai",
      runToolLoop: (spec) => this.runToolLoop(spec),
    };
  }

  async chat(system: string, user: string, opts: ChatOptions = {}): Promise<string> {
    const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: opts.max_tokens ?? DEFAULT_MAX_TOKENS,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
    let response: OpenAI.Chat.Completions.ChatCompletion;
    if (opts.temperature === undefined) {
      response = await this.client.chat.completions.create(body);
    } else {
      try {
        response = await this.client.chat.completions.create({ ...body, temperature: opts.temperature });
      } catch (err) {
        // Some endpoints (reasoning models) reject sampling params; temperature
        // is advisory, so retry once without it rather than failing the call.
        if (!(err instanceof OpenAI.BadRequestError) || !/temperature/i.test(err.message)) throw err;
        response = await this.client.chat.completions.create(body);
      }
    }
    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error("No text in OpenAI-compatible response");
    return text;
  }

  /**
   * Chat Completions function-calling loop. Mirrors the Anthropic loop: hard
   * tool-call budget, then `tool_choice: "none"` plus a nudge for the final
   * answer. Works against any endpoint that implements `tools` (OpenAI,
   * DeepSeek, Groq, …); endpoints that don't should use the inline runtime.
   */
  private async runToolLoop(spec: NativeToolLoopSpec): Promise<NativeToolLoopResult> {
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = spec.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.json_schema },
    }));
    const byName = new Map(spec.tools.map((t) => [t.name, t]));
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: spec.system_prompt },
      { role: "user", content: spec.user_prompt },
    ];
    const usage = { input: 0, output: 0 };
    let calls = 0;
    let exhausted = spec.max_tool_calls <= 0;

    for (let turn = 0; turn < spec.max_tool_calls + 2; turn++) {
      spec.signal?.throwIfAborted();
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          max_tokens: Math.max(spec.max_output_tokens ?? 0, DEFAULT_MAX_TOKENS),
          messages,
          tools,
          tool_choice: exhausted ? "none" : "auto",
        },
        { signal: spec.signal }
      );
      usage.input += response.usage?.prompt_tokens ?? 0;
      usage.output += response.usage?.completion_tokens ?? 0;

      const message = response.choices[0]?.message;
      const toolCalls = (message?.tool_calls ?? []).filter(
        (tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => tc.type === "function"
      );
      if (!message || toolCalls.length === 0) {
        return { text: (message?.content ?? "").trim(), tool_calls: calls, tokens_used: usage };
      }

      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: toolCalls });
      for (const call of toolCalls) {
        let content: string;
        if (calls >= spec.max_tool_calls) {
          content = "error: tool budget exhausted";
        } else {
          calls++;
          const tool = byName.get(call.function.name);
          if (!tool) {
            content = `error: unknown tool "${call.function.name}"`;
          } else {
            try {
              const input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
              content = await tool.execute(input);
            } catch (err) {
              content = `error: ${(err as Error).message}`;
            }
          }
        }
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
      exhausted = calls >= spec.max_tool_calls;
      if (exhausted) messages.push({ role: "user", content: BUDGET_EXHAUSTED_NUDGE });
    }
    throw new Error("OpenAI-compatible tool loop did not produce a final answer");
  }
}
