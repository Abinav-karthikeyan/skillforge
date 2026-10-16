import { join } from "path";
import { ClaudeCodePayload, normalizeClaudeCode } from "../normalize.js";
import { mergeNestedHooks, removeNestedHooks } from "./nested-hooks.js";
import { argsObject, dirExists, editPayload, looksFailed, onPath, responseText, shellPayload, str } from "./shared.js";
import { captureCommand, HostAdapter } from "./types.js";

/**
 * Gemini CLI hooks. Confirmed against geminicli.com/docs/hooks/reference
 * (2026-10): common `session_id`, `transcript_path`, `cwd`, `hook_event_name`;
 * SessionStart {source}, SessionEnd {reason}, BeforeAgent {prompt}, AfterAgent
 * {prompt_response}, AfterTool {tool_name, tool_input, tool_response
 * {llmContent, returnDisplay, error?}}, PreCompress {trigger}.
 *
 * Note: those docs say Gemini CLI was superseded by Antigravity CLI in June
 * 2026. Gemini waits for hooks, so capture must stay append-and-exit.
 */
const EVENTS = ["SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent", "AfterTool", "PreCompress"];

function translate(raw: Record<string, unknown>): ClaudeCodePayload[] {
  switch (raw.hook_event_name) {
    case "SessionStart":
      return [{ hook_event_name: "SessionStart", source: str(raw.source) ?? "startup" }];
    case "SessionEnd":
      return [{ hook_event_name: "SessionEnd", reason: str(raw.reason) ?? "other" }];
    case "BeforeAgent":
      return [{ hook_event_name: "UserPromptSubmit", prompt: str(raw.prompt) ?? "" }];
    case "AfterAgent":
      return [{ hook_event_name: "Stop", last_assistant_message: str(raw.prompt_response) ?? "" }];
    case "PreCompress":
      return [{ hook_event_name: "PreCompact", trigger: str(raw.trigger) ?? "auto" }];
    case "AfterTool": {
      const tool = str(raw.tool_name) ?? "unknown";
      const input = argsObject(raw.tool_input);
      const response = (raw.tool_response ?? {}) as Record<string, unknown>;
      const text = responseText(response);
      const error = response.error !== undefined && response.error !== null ? responseText(response.error) : "";
      if (tool === "run_shell_command") {
        return [shellPayload(str(input.command) ?? "", error || text, error ? 1 : looksFailed(text))];
      }
      const path = str(input.file_path) ?? str(input.path);
      if (path && /^(write_file|replace|edit)$/.test(tool)) {
        // Inferred: write_file reports "created … new file" vs "overwrote" in its result text.
        return [editPayload(path, tool === "write_file" && /\bcreated\b/i.test(text) ? "create" : "edit")];
      }
      return [error
        ? { hook_event_name: "PostToolUseFailure", tool_name: tool, tool_input: input, error }
        : { hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_response: response }];
    }
    default:
      return [];
  }
}

export const geminiAdapter: HostAdapter = {
  name: "gemini-cli",
  label: "Gemini CLI",
  confidence: "verified",
  docs: "https://geminicli.com/docs/hooks/reference/",
  notes: "Gemini CLI's docs say it was superseded by Antigravity CLI (June 2026).",
  parse(raw) {
    return {
      sessionId: str(raw.session_id),
      cwd: str(raw.cwd),
      transcriptPath: str(raw.transcript_path),
      events: translate(raw).flatMap((p) => normalizeClaudeCode(p)),
    };
  },
  detect: (home) => dirExists(home, ".gemini") || onPath("gemini"),
  configPath: (ctx) => (ctx.scope === "user" ? join(ctx.home, ".gemini", "settings.json") : join(ctx.projectDir, ".gemini", "settings.json")),
  install(ctx) {
    const command = captureCommand("gemini-cli", ctx);
    const handler = { type: "command", command, name: "skill-forge observer", timeout: 10_000 };
    const ours = Object.fromEntries(EVENTS.map((e) => [e, [e === "AfterTool" ? { matcher: "*", hooks: [handler] } : { hooks: [handler] }]]));
    const path = this.configPath(ctx);
    mergeNestedHooks(path, ours);
    return { path, events: EVENTS };
  },
  uninstall(ctx) {
    const path = this.configPath(ctx);
    return { path, removed: removeNestedHooks(path) };
  },
};
