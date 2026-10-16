import { join } from "path";
import { ClaudeCodePayload, normalizeClaudeCode } from "../normalize.js";
import { dirExists, editPayload, isOurs, looksFailed, readJsonConfig, responseText, shellPayload, str, writeJsonConfig } from "./shared.js";
import { captureCommand, HostAdapter } from "./types.js";

/**
 * Cursor agent hooks. Events and fields confirmed against cursor.com/docs/agent/hooks
 * (2026-10): common `conversation_id`, `workspace_roots`, `transcript_path`,
 * `hook_event_name`; `beforeSubmitPrompt {prompt}`, `afterFileEdit {file_path}`,
 * `afterShellExecution {command, output}`, `preCompact {trigger}`, `stop {status}`,
 * `sessionStart/sessionEnd {session_id, reason}`.
 *
 * Partial: afterShellExecution has no exit code, so failures are inferred
 * from the output. User-level hooks don't run in Cursor cloud agents.
 */
const EVENTS = ["sessionStart", "sessionEnd", "beforeSubmitPrompt", "afterFileEdit", "afterShellExecution", "afterMCPExecution", "postToolUseFailure", "preCompact", "stop"];

function translate(raw: Record<string, unknown>): ClaudeCodePayload[] {
  switch (raw.hook_event_name) {
    case "sessionStart":
      return [{ hook_event_name: "SessionStart", source: raw.is_background_agent ? "background" : "startup" }];
    case "sessionEnd":
      return [{ hook_event_name: "SessionEnd", reason: str(raw.reason) ?? str(raw.final_status) ?? "other" }];
    case "beforeSubmitPrompt":
      return [{ hook_event_name: "UserPromptSubmit", prompt: str(raw.prompt) ?? "" }];
    case "afterFileEdit": {
      if (!str(raw.file_path)) return [];
      // A single edit from an empty old_string is a new file.
      const edits = Array.isArray(raw.edits) ? (raw.edits as Array<{ old_string?: string }>) : [];
      const created = edits.length > 0 && edits.every((e) => (e.old_string ?? "") === "");
      return [editPayload(raw.file_path as string, created ? "create" : "edit")];
    }
    case "afterShellExecution": {
      const output = responseText(raw.output);
      return [shellPayload(str(raw.command) ?? "", output, looksFailed(output))];
    }
    case "afterMCPExecution":
      return [{ hook_event_name: "PostToolUse", tool_name: `mcp:${str(raw.mcp_server_name) ?? "?"}:${str(raw.tool_name) ?? "?"}`, tool_input: {} }];
    case "postToolUseFailure":
      return [{ hook_event_name: "PostToolUseFailure", tool_name: str(raw.tool_name) ?? "unknown", tool_input: (raw.tool_input as Record<string, unknown>) ?? {}, error: str(raw.error) ?? responseText(raw.error) }];
    case "preCompact":
      return [{ hook_event_name: "PreCompact", trigger: str(raw.trigger) ?? "auto" }];
    case "stop":
      return [{ hook_event_name: "Stop", last_assistant_message: str(raw.status) === "completed" ? "" : `turn ended: ${str(raw.status) ?? "unknown"}` }];
    default:
      return [];
  }
}

export const cursorAdapter: HostAdapter = {
  name: "cursor",
  label: "Cursor",
  confidence: "partial",
  docs: "https://cursor.com/docs/agent/hooks",
  notes: "Shell exit codes aren't in Cursor's payload; failures are inferred from output. Cursor waits for hooks, so capture stays append-only.",
  parse(raw) {
    const roots = Array.isArray(raw.workspace_roots) ? (raw.workspace_roots as unknown[]).filter((r): r is string => typeof r === "string") : [];
    return {
      sessionId: str(raw.conversation_id) ?? str(raw.session_id),
      cwd: str(raw.cwd) ?? roots[0],
      transcriptPath: str(raw.transcript_path),
      events: translate(raw).flatMap((p) => normalizeClaudeCode(p)),
      // beforeSubmitPrompt expects a reply; never block the user's prompt.
      ack: raw.hook_event_name === "beforeSubmitPrompt" ? { continue: true } : undefined,
    };
  },
  detect: (home) => dirExists(home, ".cursor"),
  configPath: (ctx) => (ctx.scope === "user" ? join(ctx.home, ".cursor", "hooks.json") : join(ctx.projectDir, ".cursor", "hooks.json")),
  install(ctx) {
    const path = this.configPath(ctx);
    const config = readJsonConfig(path);
    const hooks = (config.hooks as Record<string, Array<Record<string, unknown>>> | undefined) ?? {};
    const command = captureCommand("cursor", ctx);
    for (const e of EVENTS) hooks[e] = [...(hooks[e] ?? []).filter((h) => !isOurs(h)), { command }];
    writeJsonConfig(path, { version: config.version ?? 1, ...config, hooks });
    return { path, events: EVENTS };
  },
  uninstall(ctx) {
    const path = this.configPath(ctx);
    const config = readJsonConfig(path);
    const hooks = (config.hooks as Record<string, Array<Record<string, unknown>>> | undefined) ?? {};
    let removed = false;
    for (const [e, list] of Object.entries(hooks)) {
      const kept = list.filter((h) => !isOurs(h));
      if (kept.length !== list.length) removed = true;
      if (kept.length) hooks[e] = kept;
      else delete hooks[e];
    }
    if (removed) writeJsonConfig(path, { ...config, hooks });
    return { path, removed };
  },
};
