export interface ChatOptions {
  /**
   * Sampling temperature. Advisory: providers drop it where the model rejects
   * sampling parameters (current Claude models return a 400 for them).
   */
  temperature?: number;
  max_tokens?: number;
}

export interface LLMClient {
  chat(system: string, user: string, opts?: ChatOptions): Promise<string>;
  /**
   * Provider-native tool calling. Present only on providers that implement it;
   * the JSON-envelope loop in src/orchestrator/subagent/tool-loop.ts is the
   * floor for everything else (Ollama, mocks, unknown endpoints).
   */
  readonly nativeTools?: NativeToolCapability;
}

export type ProviderName = "anthropic" | "openai" | "ollama" | "openai-compatible";

export type NativeToolProtocol = "anthropic" | "openai";

/**
 * A tool as a provider sees it: JSON Schema in, string out. The orchestrator
 * adapts its Zod-typed ToolDefs into this shape, so this layer never imports
 * from the orchestrator.
 */
export interface NativeTool {
  name: string;
  description: string;
  json_schema: Record<string, unknown>;
  /** Validates and runs the tool. Throwing reports an error result to the model. */
  execute(input: unknown): Promise<string>;
}

export interface NativeToolLoopSpec {
  system_prompt: string;
  user_prompt: string;
  tools: NativeTool[];
  /** Hard cap on tool executions; afterwards the model is asked to answer with tools disabled. */
  max_tool_calls: number;
  max_output_tokens?: number;
  /** Aborted when the caller's deadline elapses; in-flight requests are cancelled. */
  signal?: AbortSignal;
}

export interface NativeToolLoopResult {
  /** The model's final text turn. */
  text: string;
  tool_calls: number;
  tokens_used?: { input: number; output: number };
}

export interface NativeToolCapability {
  readonly protocol: NativeToolProtocol;
  runToolLoop(spec: NativeToolLoopSpec): Promise<NativeToolLoopResult>;
}

/** User turn sent once the tool budget is spent. Shared so providers agree. */
export const BUDGET_EXHAUSTED_NUDGE =
  "Tool budget exhausted — no more tool calls. Reply now with your final answer only.";
