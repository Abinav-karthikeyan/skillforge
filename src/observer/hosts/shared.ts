import { existsSync, readdirSync, readFileSync } from "fs";
import { delimiter, join } from "path";
import { writeFileAtomic } from "../../util/fs.js";
import { ClaudeCodePayload } from "../normalize.js";
import { CAPTURE_MARK } from "./types.js";

/** Read a JSON config file; missing or empty → {}. */
export function readJsonConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

export function writeJsonConfig(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n");
}

/** Does any string value inside `v` carry our capture marker? */
export function isOurs(v: unknown): boolean {
  return JSON.stringify(v ?? null).includes(CAPTURE_MARK);
}

/** Is a binary on PATH (any extension on Windows)? */
export function onPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try {
      if (readdirSync(dir).some((n) => n === bin || n.startsWith(bin + "."))) return true;
    } catch {
      /* unreadable PATH entry */
    }
  }
  return false;
}

export const dirExists = (...p: string[]) => existsSync(join(...p));

/**
 * Hosts without a shell exit code in their payload (Cursor, Gemini, Copilot
 * sometimes) — infer failure from the output. Conservative: only clear
 * failure markers count.
 */
export function looksFailed(output: string): number | null {
  const exit = /(?:exit(?:ed)? (?:with )?code|exit status|return code)[:\s]+(\d+)/i.exec(output);
  if (exit) return Number(exit[1]) === 0 ? null : Number(exit[1]);
  if (/(^|\n)\s*(--- )?FAIL(ED)?\b|\b[1-9]\d* (?:failed|failing|errors?)\b|Traceback \(most recent call last\)|(^|\n)panic:|(^|\n)error(\[E\d+\])?:/i.test(output)) {
    return 1;
  }
  return null;
}

/**
 * Translate a shell execution into the Claude Code shape the shared
 * normalizer understands (tests, commits, installs, deletions, reverts).
 */
export function shellPayload(command: string, output: string, exitCode: number | null): ClaudeCodePayload {
  const failed = exitCode !== null && exitCode !== 0;
  return failed
    ? { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command }, error: `Exit code ${exitCode}\n${output}` }
    : { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout: output } };
}

/** A file edit in the Claude Code shape. */
export function editPayload(path: string, op: "create" | "edit"): ClaudeCodePayload {
  return op === "create"
    ? { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path }, tool_response: { filePath: path, type: "create" } }
    : { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path }, tool_response: {} };
}

export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Tool args may arrive as an object or a JSON string. */
export function argsObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      return { command: v };
    }
  }
  return {};
}

/** Shell command from `["bash","-lc","npm test"]`, a string, or `{command}`. */
export function commandText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const parts = v.filter((x): x is string => typeof x === "string");
    const i = parts.findIndex((p) => p === "-c" || p === "-lc" || p === "/c" || p === "-Command");
    return i !== -1 && parts[i + 1] ? parts.slice(i + 1).join(" ") : parts.join(" ");
  }
  return "";
}

/** Text of a tool response in any of the common shapes. */
export function responseText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const r = v as Record<string, unknown>;
    for (const k of ["output", "stdout", "textResultForLlm", "llmContent", "returnDisplay", "content", "result", "text"]) {
      if (typeof r[k] === "string") return r[k] as string;
    }
    return JSON.stringify(v).slice(0, 2_000);
  }
  return "";
}
