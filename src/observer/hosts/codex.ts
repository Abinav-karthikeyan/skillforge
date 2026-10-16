import { join } from "path";
import { ClaudeCodePayload, normalizeClaudeCode, NormalizedEvent } from "../normalize.js";
import { mergeNestedHooks, removeNestedHooks } from "./nested-hooks.js";
import { commandText, dirExists, editPayload, looksFailed, onPath, responseText, shellPayload, str } from "./shared.js";
import { captureCommand, HostAdapter } from "./types.js";

/**
 * OpenAI Codex CLI. Events and fields confirmed against the official hooks
 * page (learn.chatgpt.com/docs/hooks, 2026-10): Claude-Code-shaped payloads
 * (`session_id`, `cwd`, `transcript_path`, `hook_event_name`; PostToolUse
 * with `tool_name` / `tool_input` / `tool_response`), and PreToolUse/PostToolUse
 * fire for Bash, `apply_patch` file edits, and MCP tools.
 *
 * Partial: the docs don't pin `tool_input` for shell (string vs argv array)
 * or `apply_patch` (patch text field), and Codex has no PostToolUseFailure, so
 * a failed command is inferred from an exit code in the response.
 */
const SHELL_TOOLS = /^(bash|shell|local_shell|exec_command|container\.exec|unified_exec)$/i;

/** File operations from an apply_patch body (`*** Add File: x`, `*** Update File: y`, …). */
export function patchOperations(patch: string): Array<{ op: "create" | "edit" | "delete"; path: string }> {
  const ops: Array<{ op: "create" | "edit" | "delete"; path: string }> = [];
  for (const m of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    if (m[3]) ops.push({ op: "create", path: m[3].trim() });
    else ops.push({ op: m[1] === "Add" ? "create" : m[1] === "Delete" ? "delete" : "edit", path: m[2].trim() });
  }
  return ops;
}

function exitCodeOf(response: unknown): number | null {
  if (response && typeof response === "object") {
    const r = response as Record<string, unknown>;
    const code = r.exit_code ?? r.exitCode ?? (r.metadata as Record<string, unknown> | undefined)?.exit_code;
    if (typeof code === "number") return code;
  }
  return looksFailed(responseText(response));
}

export function translateCodexTool(raw: Record<string, unknown>): ClaudeCodePayload[] {
  const tool = str(raw.tool_name) ?? "unknown";
  const input = (raw.tool_input ?? {}) as Record<string, unknown>;
  if (SHELL_TOOLS.test(tool)) {
    const command = commandText(input.command ?? input.cmd ?? input.argv ?? raw.tool_input);
    return [shellPayload(command, responseText(raw.tool_response), exitCodeOf(raw.tool_response))];
  }
  if (/apply_patch/i.test(tool)) {
    const patch = typeof raw.tool_input === "string" ? raw.tool_input : str(input.input) ?? str(input.patch) ?? JSON.stringify(input);
    return patchOperations(patch).map(({ op, path }) =>
      op === "delete" ? shellPayload(`rm ${path}`, "", 0) : editPayload(path, op)
    );
  }
  return [{ hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_response: raw.tool_response }];
}

const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SubagentStop", "PreCompact", "PostCompact", "SessionEnd"];

export const codexAdapter: HostAdapter = {
  name: "codex",
  label: "OpenAI Codex CLI",
  confidence: "partial",
  docs: "https://learn.chatgpt.com/docs/hooks",
  notes: "Codex asks you to review and trust new hooks: run /hooks in Codex after installing.",
  parse(raw) {
    const events: NormalizedEvent[] =
      raw.hook_event_name === "PostToolUse"
        ? translateCodexTool(raw).flatMap((p) => normalizeClaudeCode(p))
        : normalizeClaudeCode(raw as ClaudeCodePayload);
    return { sessionId: str(raw.session_id), cwd: str(raw.cwd), transcriptPath: str(raw.transcript_path), events };
  },
  detect: (home) => dirExists(home, ".codex") || onPath("codex"),
  configPath: (ctx) => (ctx.scope === "user" ? join(ctx.home, ".codex", "hooks.json") : join(ctx.projectDir, ".codex", "hooks.json")),
  install(ctx) {
    const command = captureCommand("codex", ctx);
    const ours = Object.fromEntries(
      CODEX_EVENTS.map((e) => [
        e,
        [{ hooks: [e === "SessionStart" || e === "SessionEnd" ? { type: "command", command, timeout: 5 } : { type: "command", command, async: true }] }],
      ])
    );
    const path = this.configPath(ctx);
    mergeNestedHooks(path, ours);
    return { path, events: CODEX_EVENTS };
  },
  uninstall(ctx) {
    const path = this.configPath(ctx);
    return { path, removed: removeNestedHooks(path) };
  },
};
