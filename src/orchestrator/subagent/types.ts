/**
 * SubagentRuntime — abstraction for "run a bounded, structured LLM turn on
 * behalf of the orchestrator." `InlineRuntime` (JSON-envelope tool loop over
 * plain chat) is the portable floor; `NativeToolRuntime` runs the same bounded
 * loop through a provider's own tool-calling API (./native.ts).
 *
 * The conductor (runFocusScout) owns the budget decision (which tier maps to
 * which SubagentSpec knobs) and the fallback ladder. Runtimes only own the
 * mechanics of running one bounded turn and returning its text.
 */
export interface SubagentRuntime {
  readonly name: SubagentRuntimeName;
  run(spec: SubagentSpec): Promise<SubagentResult>;
}

export type SubagentRuntimeName =
  | "inline"
  | "claude-sdk"        // native Anthropic Messages tool use
  | "openai-agents";    // native OpenAI Chat Completions function calling

export interface SubagentSpec {
  /** Full system prompt — already interpolated by the caller. */
  system_prompt: string;
  /** User-turn instruction (typically a short imperative). */
  user_prompt: string;
  /** Wall-clock deadline; the runtime must race against this and reject on timeout. */
  deadline_ms: number;
  /** Advisory output cap. Runtimes that can enforce it should; InlineRuntime cannot. */
  max_output_tokens?: number;
  /**
   * Bound on tool calls per run. When `tools` is non-empty and this is > 0
   * the runtime executes a tool loop; otherwise a single chat turn is used.
   * SDK-backed runtimes enforce this natively; InlineRuntime enforces it
   * via its JSON-envelope loop in ./tool-loop.ts.
   */
  max_tool_calls?: number;
  /**
   * Tools granted to the subagent for this run. Empty or omitted means
   * "no tool loop — one bounded chat turn only."
   */
  tools?: import("./tools/types.js").ToolDef[];
}

export interface SubagentResult {
  /** Raw model output. The caller is responsible for parsing/validating shape. */
  text: string;
  elapsed_ms: number;
  /** Populated by runtimes that expose usage; undefined for InlineRuntime. */
  tokens_used?: { input: number; output: number };
  /** Populated by runtimes with tool loops; undefined for InlineRuntime. */
  tool_calls?: number;
}

/**
 * Sentinel error message runtimes must reject with when `deadline_ms` elapses
 * before the underlying call completes. The conductor branches on this to
 * classify the fallback as `"timeout"` rather than `"provider-error"`.
 */
export const SUBAGENT_TIMEOUT_MESSAGE = "subagent-timeout";
