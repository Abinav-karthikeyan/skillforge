import { existsSync, rmSync } from "fs";
import { join } from "path";
import { ClaudeCodePayload, normalizeClaudeCode } from "../normalize.js";
import { argsObject, dirExists, editPayload, looksFailed, onPath, responseText, shellPayload, str, writeJsonConfig } from "./shared.js";
import { captureCommand, HostAdapter } from "./types.js";

/**
 * Kiro (CLI v3 / IDE). [unverified] Kiro documents its triggers
 * (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostFileCreate,
 * PostFileSave, PostFileDelete, PreTaskExec, PostTaskExec, Stop) and that a
 * command action "receives session context as JSON on STDIN", but not the
 * JSON keys. This adapter reads the likely keys tolerantly and is never part
 * of `observe install --all`; install it explicitly with `--host kiro`.
 */
const TRIGGERS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "PostFileCreate", "PostFileSave", "PostFileDelete", "Stop"];
const FILE_NAME = "skill-forge.json";

const first = (raw: Record<string, unknown>, keys: string[]) => keys.map((k) => str(raw[k])).find(Boolean);

function translate(raw: Record<string, unknown>, event: string | undefined): ClaudeCodePayload[] {
  const path = first(raw, ["file_path", "filePath", "path", "file"]);
  switch (event) {
    case "SessionStart":
      return [{ hook_event_name: "SessionStart", source: "startup" }];
    case "UserPromptSubmit":
      return [{ hook_event_name: "UserPromptSubmit", prompt: first(raw, ["prompt", "user_prompt", "USER_PROMPT"]) ?? "" }];
    case "PostFileCreate":
      return path ? [editPayload(path, "create")] : [];
    case "PostFileSave":
      return path ? [editPayload(path, "edit")] : [];
    case "PostFileDelete":
      return path ? [shellPayload(`rm ${path}`, "", 0)] : [];
    case "PostToolUse": {
      const tool = first(raw, ["tool_name", "toolName"]) ?? "unknown";
      const input = argsObject(raw.tool_input ?? raw.toolInput);
      const text = responseText(raw.tool_response ?? raw.toolResponse);
      if (/bash|shell|command/i.test(tool) && str(input.command)) return [shellPayload(input.command as string, text, looksFailed(text))];
      return [{ hook_event_name: "PostToolUse", tool_name: tool, tool_input: input }];
    }
    case "Stop":
      return [{ hook_event_name: "Stop", last_assistant_message: first(raw, ["last_assistant_message", "response"]) ?? "" }];
    default:
      return [];
  }
}

export const kiroAdapter: HostAdapter = {
  name: "kiro",
  label: "Kiro",
  confidence: "unverified",
  docs: "https://kiro.dev/docs/cli/v3/hooks-migration/",
  notes: "[unverified] Kiro doesn't publish its hook STDIN keys; fields are read tolerantly. Not installed by --all.",
  parse(raw) {
    const event = first(raw, ["hook_event_name", "trigger", "event", "hookEventName"]);
    return {
      sessionId: first(raw, ["session_id", "sessionId", "conversation_id", "conversationId"]),
      cwd: first(raw, ["cwd", "workspace", "project_root"]),
      events: translate(raw, event).flatMap((p) => normalizeClaudeCode(p)),
    };
  },
  detect: (home) => dirExists(home, ".kiro") || onPath("kiro-cli") || onPath("kiro"),
  configPath: (ctx) => (ctx.scope === "user" ? join(ctx.home, ".kiro", "hooks", FILE_NAME) : join(ctx.projectDir, ".kiro", "hooks", FILE_NAME)),
  install(ctx) {
    const base = captureCommand("kiro", ctx);
    const hooks = TRIGGERS.map((trigger) => ({
      name: `skill-forge-observe-${trigger}`,
      trigger,
      action: { type: "command", command: `${base} --event ${trigger}` },
      timeout: 10,
      enabled: true,
    }));
    const path = this.configPath(ctx);
    writeJsonConfig(path, { version: "v1", hooks });
    return { path, events: TRIGGERS };
  },
  uninstall(ctx) {
    const path = this.configPath(ctx);
    const removed = existsSync(path);
    rmSync(path, { force: true });
    return { path, removed };
  },
};
