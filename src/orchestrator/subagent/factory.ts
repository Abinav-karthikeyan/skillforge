import { LLMClient } from "../../claude/types.js";
import { CalibrationConfig, SubagentRuntimeSelection } from "../../types/config.js";
import { SubagentRuntime } from "./types.js";
import { InlineRuntime } from "./inline.js";

/**
 * Picks a SubagentRuntime based on config. Today "auto" and any unknown value
 * both resolve to InlineRuntime — the SDK-backed runtimes will register here
 * as they land. Keeping the factory small means the conductor never has to
 * grow a switch statement of its own.
 */
export function createSubagentRuntime(
  client: LLMClient,
  config: CalibrationConfig
): SubagentRuntime {
  const requested: SubagentRuntimeSelection = config.subagent_runtime ?? "auto";

  switch (requested) {
    case "inline":
    case "auto":
      return new InlineRuntime(client);

    case "claude-sdk":
    case "openai-agents":
      // Not yet implemented — fall through to inline so an eager config value
      // doesn't break users. Once the SDK-backed runtimes land they replace
      // these branches; until then, callers requesting them still get the
      // portable floor rather than an error.
      return new InlineRuntime(client);

    default:
      return new InlineRuntime(client);
  }
}
