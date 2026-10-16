import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { createClient, ProviderConfig } from "../claude/client.js";
import { loadCalibration } from "../config/calibration.js";
import { logsDir } from "../config/paths.js";
import { ingestSession } from "../ingestor/index.js";
import { generateArtifacts, resolveModes } from "../pipeline/generate.js";

/**
 * Claude Code `PostToolUse` hook for `git commit` (plan_v3 §0, step zero of
 * Pillar B). Registered with `async: true` and `if: "Bash(git commit*)"`, so it
 * runs in the background after a commit and never blocks the session.
 *
 * Contract: never hurt the host. Every failure is logged to
 * ~/.skill-forge/logs/hook.log and swallowed; the CLI wrapper always exits 0.
 */
export interface HookPayload {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: { command?: string };
}

export interface PostCommitResult {
  ran: boolean;
  reason?: string;
  files?: string[];
}

const GIT_COMMIT = /\bgit\b[^\n|;&]*\bcommit\b/;

export function parseHookPayload(raw: string | undefined): HookPayload {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as HookPayload) : {};
  } catch {
    return {};
  }
}

/**
 * Decide whether a payload is a commit worth processing. The `if` filter in
 * the hook config already narrows to `Bash(git commit*)`; this is the second
 * line of defense for hosts or configs that don't support `if`.
 */
export function shouldProcess(payload: HookPayload): { ok: boolean; reason?: string } {
  if (payload.tool_name && payload.tool_name !== "Bash") return { ok: false, reason: `tool ${payload.tool_name}` };
  const command = payload.tool_input?.command;
  if (command !== undefined && !GIT_COMMIT.test(command)) return { ok: false, reason: "not a git commit" };
  return { ok: true };
}

export function hookLog(message: string): void {
  try {
    const dir = logsDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "hook.log"), `${new Date().toISOString()} ${message}\n`, "utf-8");
  } catch {
    /* logging must never throw */
  }
}

export async function runPostCommitHook(raw: string | undefined, mode = "portfolio-bullet"): Promise<PostCommitResult> {
  const payload = parseHookPayload(raw);
  const gate = shouldProcess(payload);
  if (!gate.ok) return { ran: false, reason: gate.reason };

  // The hook may be spawned from anywhere; git context and project config
  // both resolve against the session's working directory.
  if (payload.cwd) process.chdir(payload.cwd);

  const config = loadCalibration();
  const client = createClient({
    provider: config.provider,
    model: config.model,
    base_url: config.base_url,
    api_key: config.api_key,
  } as ProviderConfig);
  const session = await ingestSession(client);
  const result = await generateArtifacts(client, config, session, resolveModes(mode));
  if (result.ledger_warning) hookLog(`warn: ${result.ledger_warning}`);
  return { ran: true, files: result.artifacts.map((a) => a.location) };
}
