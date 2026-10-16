import { existsSync, rmSync } from "fs";
import { join } from "path";
import { ClaudeCodePayload, normalizeClaudeCode } from "../normalize.js";
import { argsObject, dirExists, editPayload, looksFailed, onPath, responseText, shellPayload, str, writeJsonConfig } from "./shared.js";
import { captureCommand, HostAdapter } from "./types.js";

/**
 * GitHub Copilot CLI. Confirmed against the Copilot CLI hooks reference
 * (docs.github.com, 2026-10): camelCase events and fields — common
 * `sessionId`, `timestamp`, `cwd`; sessionStart {source, initialPrompt?},
 * sessionEnd {reason}, userPromptSubmitted {prompt}, postToolUse {toolName,
 * toolArgs, toolResult {resultType, textResultForLlm}}, postToolUseFailure
 * {toolName, toolArgs, error}, agentStop {transcriptPath, stopReason},
 * subagentStop {agentId, agentType, response}, preCompact.
 *
 * Local CLI only: the cloud coding agent runs hooks in an ephemeral sandbox
 * whose files are discarded, so it can't feed a local journal. Install is
 * therefore user-level (~/.copilot/hooks/), not .github/hooks/.
 */
const EVENTS = ["sessionStart", "sessionEnd", "userPromptSubmitted", "postToolUse", "postToolUseFailure", "agentStop", "subagentStop", "preCompact"];
const SHELL = /^(bash|powershell|shell|run_in_terminal|terminal)$/i;
const FILE_NAME = "skill-forge.json";

function translateTool(raw: Record<string, unknown>, failed: boolean): ClaudeCodePayload[] {
  const tool = str(raw.toolName) ?? "unknown";
  const args = argsObject(raw.toolArgs);
  const result = (raw.toolResult ?? {}) as Record<string, unknown>;
  const text = failed ? responseText(raw.error) : responseText(result);
  if (SHELL.test(tool)) {
    const resultFailed = failed || str(result.resultType) === "failure";
    return [shellPayload(str(args.command) ?? "", text, resultFailed ? looksFailed(text) ?? 1 : looksFailed(text))];
  }
  const path = str(args.path) ?? str(args.file_path) ?? str(args.filePath);
  if (path && !failed && /^(create|edit|str_replace|write|apply_patch|insert)$/i.test(tool)) {
    return [editPayload(path, /^create$/i.test(tool) ? "create" : "edit")];
  }
  return [failed
    ? { hook_event_name: "PostToolUseFailure", tool_name: tool, tool_input: args, error: text }
    : { hook_event_name: "PostToolUse", tool_name: tool, tool_input: args, tool_response: result }];
}

function translate(raw: Record<string, unknown>): ClaudeCodePayload[] {
  switch (raw.hook_event_name ?? raw.hookEventName) {
    case "sessionStart": {
      const out: ClaudeCodePayload[] = [{ hook_event_name: "SessionStart", source: str(raw.source) ?? "startup" }];
      if (str(raw.initialPrompt)) out.push({ hook_event_name: "UserPromptSubmit", prompt: raw.initialPrompt as string });
      return out;
    }
    case "sessionEnd":
      return [{ hook_event_name: "SessionEnd", reason: str(raw.reason) ?? "other" }];
    case "userPromptSubmitted":
      return [{ hook_event_name: "UserPromptSubmit", prompt: str(raw.prompt) ?? "" }];
    case "postToolUse":
      return translateTool(raw, false);
    case "postToolUseFailure":
      return translateTool(raw, true);
    case "agentStop":
      return [{ hook_event_name: "Stop", last_assistant_message: "" }];
    case "subagentStop":
      return [{ hook_event_name: "SubagentStop", agent_id: str(raw.agentId), agent_type: str(raw.agentType), last_assistant_message: str(raw.response) ?? "" }];
    case "preCompact":
      return [{ hook_event_name: "PreCompact", trigger: str(raw.trigger) ?? "auto" }];
    default:
      return [];
  }
}

export const copilotAdapter: HostAdapter = {
  name: "copilot",
  label: "GitHub Copilot CLI",
  confidence: "verified",
  docs: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference",
  notes: "Local Copilot CLI only; the cloud coding agent's sandbox can't write to your journal.",
  parse(raw) {
    // The hook config passes the event name as an argument-free command, so
    // the event is identified by payload shape when hookEventName is absent.
    const event =
      str(raw.hook_event_name) ?? str(raw.hookEventName) ??
      (raw.toolResult !== undefined ? "postToolUse" : raw.error !== undefined && raw.toolName ? "postToolUseFailure" : raw.prompt !== undefined ? "userPromptSubmitted" : raw.stopReason !== undefined && raw.agentId ? "subagentStop" : raw.stopReason !== undefined ? "agentStop" : raw.reason !== undefined ? "sessionEnd" : raw.source !== undefined ? "sessionStart" : undefined);
    return {
      sessionId: str(raw.sessionId),
      cwd: str(raw.cwd),
      transcriptPath: str(raw.transcriptPath),
      events: translate({ ...raw, hook_event_name: event }).flatMap((p) => normalizeClaudeCode(p)),
    };
  },
  detect: (home) => dirExists(home, ".copilot") || onPath("copilot"),
  configPath: (ctx) =>
    ctx.scope === "user" ? join(ctx.home, ".copilot", "hooks", FILE_NAME) : join(ctx.projectDir, ".github", "hooks", FILE_NAME),
  install(ctx) {
    // One file we own outright; each event passes its name so parsing never guesses.
    const base = captureCommand("copilot", ctx);
    const hooks = Object.fromEntries(
      EVENTS.map((e) => [e, [{ type: "command", bash: `${base} --event ${e}`, powershell: `${base} --event ${e}`, timeoutSec: 10 }]])
    );
    const path = this.configPath(ctx);
    writeJsonConfig(path, { version: 1, hooks });
    return { path, events: EVENTS };
  },
  uninstall(ctx) {
    const path = this.configPath(ctx);
    const removed = existsSync(path);
    rmSync(path, { force: true });
    return { path, removed };
  },
};
