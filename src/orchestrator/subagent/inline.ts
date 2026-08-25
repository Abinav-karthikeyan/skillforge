import { LLMClient } from "../../claude/types.js";
import { callClaude } from "../../claude/client.js";
import {
  SubagentRuntime,
  SubagentSpec,
  SubagentResult,
  SUBAGENT_TIMEOUT_MESSAGE,
} from "./types.js";
import { runToolLoop } from "./tool-loop.js";

/**
 * InlineRuntime — the floor implementation. Makes one LLMClient.chat() call
 * against whichever provider is already configured for the main pipeline
 * (Anthropic / OpenAI-compatible / Ollama). No tool loop, no per-runtime
 * dependency, no separate context window beyond what the prompt carries.
 *
 * This runtime is the portability guarantee: every host that can run the
 * `career-mode` CLI can also run the focus scout, even without an agent SDK
 * installed. Richer runtimes (Claude Agent SDK, OpenAI Agents) plug in as
 * additional SubagentRuntime implementations and never displace this one.
 *
 * Note on budgets: `max_output_tokens` and `max_tool_calls` are advisory
 * here — InlineRuntime can't enforce either. The conductor still bounds
 * cost by truncating the *input* (session summary) before it hands the
 * spec off, and by racing against `deadline_ms`.
 */
export class InlineRuntime implements SubagentRuntime {
  readonly name = "inline" as const;

  constructor(private readonly client: LLMClient) {}

  async run(spec: SubagentSpec): Promise<SubagentResult> {
    const started = Date.now();
    const useTools = (spec.tools?.length ?? 0) > 0 && (spec.max_tool_calls ?? 0) > 0;

    if (useTools) {
      const loop = await runToolLoop(this.client, {
        system_prompt: spec.system_prompt,
        user_prompt: spec.user_prompt,
        tools: spec.tools!,
        max_tool_calls: spec.max_tool_calls!,
        deadline_ms: spec.deadline_ms,
      });
      return {
        text: loop.text,
        elapsed_ms: Date.now() - started,
        tool_calls: loop.tool_calls,
      };
    }

    const chatCall = callClaude(this.client, spec.system_prompt, spec.user_prompt);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(SUBAGENT_TIMEOUT_MESSAGE)), spec.deadline_ms)
    );

    const text = await Promise.race([chatCall, timeout]);
    return { text, elapsed_ms: Date.now() - started };
  }
}
