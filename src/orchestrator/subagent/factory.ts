import { LLMClient, NativeToolProtocol } from "../../claude/types.js";
import { CalibrationConfig, SubagentRuntimeSelection } from "../../types/config.js";
import { SubagentRuntime } from "./types.js";
import { InlineRuntime } from "./inline.js";
import { NativeToolRuntime } from "./native.js";

/**
 * Picks a SubagentRuntime based on config.
 *
 *   auto | inline   → InlineRuntime (JSON-envelope loop over plain chat; the
 *                     portable floor, and still the default)
 *   native          → provider-native tool calling when the configured
 *                     provider supports it, else inline
 *   claude-sdk      → native Anthropic Messages tool use (inline unless the
 *                     provider is Anthropic)
 *   openai-agents   → native Chat Completions function calling (inline
 *                     unless the provider is OpenAI-compatible)
 *
 * A selection the provider can't honor degrades to inline rather than
 * erroring, so an eager config value never breaks generation.
 */
export function createSubagentRuntime(
  client: LLMClient,
  config: CalibrationConfig
): SubagentRuntime {
  const requested: SubagentRuntimeSelection = config.subagent_runtime ?? "auto";
  const native = client.nativeTools;
  const nativeFor = (protocol: NativeToolProtocol): SubagentRuntime =>
    native && native.protocol === protocol
      ? new NativeToolRuntime(client, native, protocol === "anthropic" ? "claude-sdk" : "openai-agents")
      : new InlineRuntime(client);

  switch (requested) {
    case "native":
      return native ? nativeFor(native.protocol) : new InlineRuntime(client);
    case "claude-sdk":
      return nativeFor("anthropic");
    case "openai-agents":
      return nativeFor("openai");
    case "inline":
    case "auto":
    default:
      return new InlineRuntime(client);
  }
}
