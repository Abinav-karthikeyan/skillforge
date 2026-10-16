import { z } from "zod";
import { LLMClient, NativeTool, NativeToolCapability } from "../../claude/types.js";
import { callClaude } from "../../claude/client.js";
import { ToolDef } from "./tools/types.js";
import {
  SubagentRuntime,
  SubagentRuntimeName,
  SubagentSpec,
  SubagentResult,
  SUBAGENT_TIMEOUT_MESSAGE,
} from "./types.js";

/**
 * Appended to the system prompt on the native path. Prompts written for the
 * inline runtime describe a JSON `call_tool`/`final` envelope; here tools go
 * through the provider's own tool-calling API, so only the final answer shape
 * needs restating. The envelope is still accepted on the way out.
 */
const NATIVE_PROTOCOL = [
  "",
  "Tool use: call the provided tools through the native tool-calling interface — do not",
  "write tool calls as JSON text. When you are done, reply with ONLY the final JSON result",
  '(either the bare result object, or {"action":"final","result": { ... }}). No prose, no fences.',
].join("\n");

/** Adapt a Zod-typed ToolDef into the provider-facing NativeTool shape. */
export function toNativeTool(tool: ToolDef): NativeTool {
  const schema = z.toJSONSchema(tool.input_schema as z.ZodType, { io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return {
    name: tool.name,
    description: tool.description,
    json_schema: schema,
    execute: async (input) => tool.handler(tool.input_schema.parse(input ?? {})),
  };
}

function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();
}

/** Unwrap a `{"action":"final","result":…}` envelope if the model used one. */
export function unwrapFinalEnvelope(text: string): string {
  try {
    const obj = JSON.parse(stripFences(text));
    if (obj && typeof obj === "object" && obj.action === "final" && "result" in obj) {
      return typeof obj.result === "string" ? obj.result : JSON.stringify(obj.result);
    }
  } catch {
    /* not an envelope — return as-is */
  }
  return text;
}

/**
 * NativeToolRuntime — runs the orchestrator's bounded tool loop through the
 * provider's own tool-calling API (Anthropic Messages `tools`, OpenAI Chat
 * Completions `tools`). Fills the `claude-sdk` / `openai-agents` slots that v2
 * reserved; the inline JSON-envelope loop remains the floor for providers
 * without native tool use (Ollama, unknown endpoints).
 */
export class NativeToolRuntime implements SubagentRuntime {
  constructor(
    private readonly client: LLMClient,
    private readonly capability: NativeToolCapability,
    readonly name: SubagentRuntimeName
  ) {}

  async run(spec: SubagentSpec): Promise<SubagentResult> {
    const started = Date.now();
    const useTools = (spec.tools?.length ?? 0) > 0 && (spec.max_tool_calls ?? 0) > 0;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(SUBAGENT_TIMEOUT_MESSAGE));
      }, spec.deadline_ms);
    });

    try {
      if (!useTools) {
        const text = await Promise.race([
          callClaude(this.client, spec.system_prompt, spec.user_prompt),
          timeout,
        ]);
        return { text, elapsed_ms: Date.now() - started };
      }

      const loop = await Promise.race([
        this.capability.runToolLoop({
          system_prompt: spec.system_prompt + NATIVE_PROTOCOL,
          user_prompt: spec.user_prompt,
          tools: spec.tools!.map(toNativeTool),
          max_tool_calls: spec.max_tool_calls!,
          max_output_tokens: spec.max_output_tokens,
          signal: controller.signal,
        }),
        timeout,
      ]);
      return {
        text: unwrapFinalEnvelope(loop.text),
        elapsed_ms: Date.now() - started,
        tool_calls: loop.tool_calls,
        tokens_used: loop.tokens_used,
      };
    } catch (err) {
      // An abort surfaces from the SDK as its own error type; normalize it.
      if (controller.signal.aborted) throw new Error(SUBAGENT_TIMEOUT_MESSAGE);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
