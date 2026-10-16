import type { ObservedEventKind } from "../types/ledger.js";
import { capString, commandTouchesSecretFile, isSecretFile, REDACTED, redactText, redactValue } from "./redact.js";

/**
 * Host payload → normalized event (plan_v3 §3.3 hot path). Everything stored
 * is redacted and size-capped here; nothing downstream sees the raw payload.
 * Kept free of heavy imports (no zod, no SDKs) because it runs once per hook
 * event.
 */
export interface NormalizedEvent {
  kind: ObservedEventKind;
  agent_id?: string;
  payload: Record<string, unknown>;
}

/** The Claude Code hook payload fields this module reads (see the hooks reference). */
export interface ClaudeCodePayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  agent_id?: string;
  agent_type?: string;
  source?: string;
  reason?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  error?: string;
  is_interrupt?: boolean;
  last_assistant_message?: string;
  trigger?: string;
  custom_instructions?: string | null;
  compact_summary?: string;
}

// ── shell-command classification ───────────────────────────────────────────

const TEST_RUNNERS: Array<[RegExp, string]> = [
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)(?::\S+)?\b/, "npm test"],
  [/\bvitest\b/, "vitest"],
  [/\bjest\b/, "jest"],
  [/\bmocha\b/, "mocha"],
  [/\bplaywright\s+test\b/, "playwright"],
  [/\b(?:pytest|py\.test)\b|python\d?\s+-m\s+(?:pytest|unittest)\b/, "pytest"],
  [/\bgo\s+test\b/, "go test"],
  [/\bcargo\s+(?:test|nextest)\b/, "cargo test"],
  [/\bdotnet\s+test\b/, "dotnet test"],
  [/\b(?:mvn|mvnw|\.\/mvnw)\b.*\btest\b/, "maven test"],
  [/\bgradlew?\b.*\btest\b/, "gradle test"],
  [/\b(?:rspec|phpunit|tox|nox)\b/, "test"],
];

/** The test runner a command invokes, or null. */
export function testRunner(command: string): string | null {
  for (const [re, name] of TEST_RUNNERS) if (re.test(command)) return name;
  return null;
}

export function isGitCommit(command: string): boolean {
  return /\bgit\b[^\n|;&]*\bcommit\b/.test(command) && !/\bcommit-tree\b/.test(command);
}

const argsOf = (rest: string) =>
  rest
    .split(/\s+/)
    .map((t) => t.replace(/^["']|["']$/g, ""))
    // Drop flags and redirections (">", "2>&1", "<in"), keep specifiers like "fastapi>=0.1".
    .filter((t) => t && !t.startsWith("-") && !/^(\d*[<>]|[&|;])/.test(t));

/** Install flags whose next token is a value, not a package. */
const VALUE_FLAGS = new Set([
  "--features", "-F", "--registry", "--index-url", "-i", "--extra-index-url", "--target", "-t",
  "--prefix", "--version", "-v", "--source", "-s", "--framework", "-f", "--tag", "--rev",
  "--branch", "--git", "--path", "--rename", "--group", "-G", "--package", "-p",
]);

function packageArgs(rest: string): string[] {
  const tokens = rest.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (VALUE_FLAGS.has(t)) {
      i++;
      continue;
    }
    if (t && !t.startsWith("-") && !/^(\d*[<>]|[&|;])/.test(t)) out.push(t);
  }
  return out;
}

/** Packages a command installs (npm/pnpm/yarn/bun, pip, uv, poetry, cargo, go, dotnet). */
export function installedPackages(command: string): string[] {
  const out: string[] = [];
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const s = segment.trim();
    const m =
      /^(?:npm|pnpm|bun)\s+(?:i|install|add)\s+(.+)$/.exec(s) ??
      /^yarn\s+add\s+(.+)$/.exec(s) ??
      /^(?:pip3?|python\d?\s+-m\s+pip|uv\s+pip)\s+install\s+(.+)$/.exec(s) ??
      /^(?:uv|poetry|cargo)\s+add\s+(.+)$/.exec(s) ??
      /^go\s+get\s+(.+)$/.exec(s) ??
      /^dotnet\s+add\s+(?:\S+\s+)?package\s+(.+)$/.exec(s);
    if (m) {
      out.push(
        ...packageArgs(m[1]).map((p) =>
          p
            .replace(/\[[^\]]*\]/g, "") // pip extras: pyjwt[crypto]
            .replace(/(?<=.)@[^/]*$/, "") // npm version: zod@4 (keeps @scope/)
            .replace(/[<>=!~].*$/, "") // pip specifiers: fastapi>=0.1
        )
      );
    }
  }
  return [...new Set(out.filter(Boolean))];
}

/** Paths a command deletes (rm, del, rmdir, Remove-Item, git rm). */
export function deletedPaths(command: string): string[] {
  const out: string[] = [];
  for (const segment of command.split(/&&|\|\||;/)) {
    const m = /^\s*(?:rm|del|erase|rmdir|rd|Remove-Item|git\s+rm)\b(.*)$/i.exec(segment);
    if (m) out.push(...argsOf(m[1]));
  }
  return out;
}

/** Paths a command reverts to their committed state; "*" for a whole-tree reset. */
export function revertedPaths(command: string): string[] {
  const out: string[] = [];
  for (const segment of command.split(/&&|\|\||;/)) {
    const s = segment.trim();
    if (/^git\s+reset\s+--hard\b/.test(s) || /^git\s+checkout\s+(?:HEAD\s+)?--\s*\.?\s*$/.test(s) || /^git\s+stash\b(?!\s+(?:pop|apply|list|show))/.test(s)) {
      out.push("*");
      continue;
    }
    const m = /^git\s+(?:checkout\s+(?:\S+\s+)?--|restore(?:\s+--(?:worktree|staged|source=\S+))*)\s+(.+)$/.exec(s);
    if (m) out.push(...argsOf(m[1]));
  }
  return out;
}

const MANIFEST = /(^|[\\/])(package\.json|requirements[^\\/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|[^\\/]+\.csproj|Gemfile|composer\.json)$/;
export const isManifestPath = (p: string) => MANIFEST.test(p);

// ── payload → event ────────────────────────────────────────────────────────

function text(v: unknown, max: number): string {
  return typeof v === "string" ? capString(redactText(v), max) : "";
}

function responseText(response: unknown, max: number): string {
  if (typeof response === "string") return text(response, max);
  if (response && typeof response === "object") {
    const r = response as Record<string, unknown>;
    const parts = [r.stdout, r.stderr, r.output, r.content, r.result].filter((p) => typeof p === "string") as string[];
    if (parts.length) return text(parts.join("\n"), max);
  }
  return "";
}

/** `[main 1a2b3c4] message` → { sha, message } from `git commit` output. */
export function parseCommitOutput(output: string): { sha?: string; message?: string } {
  const m = /\[[^\]\s]+(?:\s+\([^)]*\))?\s+([0-9a-f]{7,40})\]\s*(.*)/.exec(output);
  return m ? { sha: m[1], message: m[2].trim().slice(0, 200) } : {};
}

function filePathOf(input: Record<string, unknown> | undefined): string | undefined {
  const p = input?.file_path ?? input?.path ?? input?.notebook_path;
  return typeof p === "string" ? p : undefined;
}

function bashEvent(p: ClaudeCodePayload, failed: boolean): NormalizedEvent {
  const command = typeof p.tool_input?.command === "string" ? (p.tool_input.command as string) : "";
  const secret = commandTouchesSecretFile(command);
  const output = secret ? REDACTED : failed ? text(p.error, 1_500) : responseText(p.tool_response, 1_500);
  const payload: Record<string, unknown> = { tool: p.tool_name, command: text(command, 1_000), ok: !failed };
  if (failed) {
    const exit = /^Exit code (\d+)/.exec(p.error ?? "");
    if (exit) payload.exit_code = Number(exit[1]);
    if (p.is_interrupt) payload.interrupted = true;
  }
  if (output) payload.output = output;

  const installs = installedPackages(command);
  if (installs.length) payload.installed = installs;
  const deleted = deletedPaths(command);
  if (deleted.length) payload.deleted_paths = deleted;
  const reverted = revertedPaths(command);
  if (reverted.length) payload.reverted_paths = reverted;

  const runner = testRunner(command);
  if (runner && !p.is_interrupt) {
    return { kind: "test_run", agent_id: p.agent_id, payload: { ...payload, runner, passed: !failed } };
  }
  if (isGitCommit(command) && !failed) {
    const raw = typeof p.tool_response === "object" ? responseText(p.tool_response, 4_000) : String(p.tool_response ?? "");
    return { kind: "commit", agent_id: p.agent_id, payload: { ...payload, ...parseCommitOutput(raw) } };
  }
  return { kind: "tool_result", agent_id: p.agent_id, payload };
}

/** Normalize one Claude Code hook payload. Unknown events yield nothing. */
export function normalizeClaudeCode(p: ClaudeCodePayload): NormalizedEvent[] {
  const agent_id = p.agent_id;
  switch (p.hook_event_name) {
    case "SessionStart":
      return [{ kind: "session_start", payload: { source: p.source ?? "startup" } }];
    case "UserPromptSubmit":
      return [{ kind: "prompt", agent_id, payload: { text: text(p.prompt, 4_000) } }];
    case "PostToolUse":
    case "PostToolUseFailure": {
      const failed = p.hook_event_name === "PostToolUseFailure";
      const tool = p.tool_name ?? "unknown";
      if (tool === "Bash" || tool === "PowerShell") return [bashEvent(p, failed)];
      const path = filePathOf(p.tool_input);
      if (!failed && path && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) {
        const op =
          tool === "Write"
            ? (p.tool_response as { type?: string } | undefined)?.type === "create" ? "create" : "update"
            : "edit";
        // Paths only — file contents are never journaled.
        return [{ kind: "file_edit", agent_id, payload: { tool, path, op, manifest: isManifestPath(path) || undefined, secret_file: isSecretFile(path) || undefined } }];
      }
      const target = path ?? p.tool_input?.pattern ?? p.tool_input?.url ?? p.tool_input?.query ?? p.tool_input?.description;
      const payload: Record<string, unknown> = { tool, ok: !failed };
      if (typeof target === "string") payload.target = text(target, 300);
      if (failed) payload.error = text(p.error, 800);
      return [{ kind: "tool_result", agent_id, payload }];
    }
    case "Stop":
    case "SubagentStop":
      return [
        {
          kind: "turn_end",
          agent_id,
          payload: {
            message: text(p.last_assistant_message, p.hook_event_name === "Stop" ? 2_000 : 1_000),
            ...(p.agent_type ? { agent_type: p.agent_type } : {}),
          },
        },
      ];
    case "PreCompact":
      return [{ kind: "compaction", payload: { phase: "pre", trigger: p.trigger ?? "auto", instructions: text(p.custom_instructions, 500) || undefined } }];
    case "PostCompact":
      return [{ kind: "compaction", payload: { phase: "post", trigger: p.trigger ?? "auto", summary: text(p.compact_summary, 12_000) } }];
    case "SessionEnd":
      return [{ kind: "session_end", payload: { reason: p.reason ?? "other" } }];
    default:
      return [];
  }
}

/** Last-resort redaction of an arbitrary payload (unknown hosts / events). */
export function redactPayload(raw: unknown): Record<string, unknown> {
  const v = redactValue(raw, 2_000);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
}
