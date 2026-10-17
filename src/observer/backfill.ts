import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { capturePayload } from "./capture.js";
import { Journal } from "./journal.js";
import { ClaudeCodePayload } from "./normalize.js";
import { loadObserveSettings, ObserveSettings, repoPolicy } from "./settings.js";

/**
 * Backfill (plan_v3 §3.3): replay existing Claude Code transcripts
 * (`~/.claude/projects/<project>/<session>.jsonl`) through the same capture
 * path a live hook uses — same normalization, same redaction, same
 * detectors — so users get stories on day one instead of after a month of
 * observing. Opt-in and allowlist-bound like live capture.
 *
 * Transcripts are append-only and keep pre-compaction entries (a
 * `compact_boundary` system line marks the cut), so the full session is
 * recoverable.
 */
interface TranscriptLine {
  type?: string;
  subtype?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isSidechain?: boolean;
  toolUseResult?: unknown;
  compactMetadata?: { trigger?: string };
  message?: { role?: string; content?: unknown };
}

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export function claudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

/** Transcript files modified since `sinceMs`. */
export function findTranscripts(sinceMs: number, root = claudeProjectsDir()): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const project of readdirSync(root)) {
    const dir = join(root, project);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const full = join(dir, name);
      try {
        if (statSync(full).mtimeMs >= sinceMs) out.push(full);
      } catch {
        /* vanished */
      }
    }
  }
  return out.sort();
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .map((b) => (typeof b === "string" ? b : b.type === "text" ? b.text ?? "" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Prompts that are tool plumbing, not something the user typed. */
function isSyntheticPrompt(text: string): boolean {
  return /^\s*<(command-|local-command|system-reminder|task-notification|bash-)/.test(text) || text.trim() === "";
}

/**
 * Convert one transcript into the hook payloads Claude Code would have sent
 * live: UserPromptSubmit, PostToolUse(Failure), Stop, Pre/PostCompact, and a
 * closing SessionEnd.
 */
export function transcriptToPayloads(lines: TranscriptLine[]): ClaudeCodePayload[] {
  const payloads: ClaudeCodePayload[] = [];
  const toolUses = new Map<string, { name: string; input: Record<string, unknown> }>();
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let lastAssistantText = "";
  let turnOpen = false;

  const base = () => ({ session_id: sessionId, cwd });
  const closeTurn = () => {
    if (turnOpen) payloads.push({ ...base(), hook_event_name: "Stop", last_assistant_message: lastAssistantText });
    turnOpen = false;
    lastAssistantText = "";
  };

  for (const line of lines) {
    sessionId ??= line.sessionId;
    cwd = line.cwd ?? cwd;
    if (line.isSidechain) continue; // subagent internals; their parent tool call is enough

    if (line.type === "system" && line.subtype === "compact_boundary") {
      closeTurn();
      payloads.push({ ...base(), hook_event_name: "PreCompact", trigger: line.compactMetadata?.trigger ?? "auto" });
      continue;
    }
    if (line.type === "user" && line.isCompactSummary) {
      payloads.push({ ...base(), hook_event_name: "PostCompact", trigger: "auto", compact_summary: blockText(line.message?.content) });
      continue;
    }
    if (line.type === "assistant") {
      const content = line.message?.content;
      if (Array.isArray(content)) {
        for (const b of content as ContentBlock[]) {
          if (b.type === "tool_use" && b.id) toolUses.set(b.id, { name: b.name ?? "unknown", input: b.input ?? {} });
          if (b.type === "text" && b.text) lastAssistantText = b.text;
        }
      }
      continue;
    }
    if (line.type === "user" && !line.isMeta) {
      const content = line.message?.content;
      const blocks = Array.isArray(content) ? (content as ContentBlock[]) : [];
      const results = blocks.filter((b) => b.type === "tool_result");
      if (results.length) {
        for (const r of results) {
          const use = r.tool_use_id ? toolUses.get(r.tool_use_id) : undefined;
          if (!use) continue;
          const text = blockText(r.content);
          payloads.push(
            r.is_error
              ? { ...base(), hook_event_name: "PostToolUseFailure", tool_name: use.name, tool_input: use.input, error: text }
              : { ...base(), hook_event_name: "PostToolUse", tool_name: use.name, tool_input: use.input, tool_response: line.toolUseResult ?? { stdout: text } }
          );
        }
        continue;
      }
      const prompt = blockText(content);
      if (isSyntheticPrompt(prompt)) continue;
      closeTurn();
      payloads.push({ ...base(), hook_event_name: "UserPromptSubmit", prompt });
      turnOpen = true;
    }
  }
  closeTurn();
  if (sessionId) payloads.push({ ...base(), hook_event_name: "SessionEnd", reason: "backfill" });
  return payloads;
}

export interface BackfillOptions {
  sinceMs: number;
  settings?: ObserveSettings;
  journal?: Journal;
  /** Re-import sessions that already have a journal. */
  force?: boolean;
  transcriptsRoot?: string;
}

export interface BackfillResult {
  imported: Array<{ session: string; repo: string; events: number }>;
  skipped: Array<{ file: string; reason: string }>;
}

/** Import transcripts into the journal. The observer/reflector passes run separately. */
export function backfillTranscripts(opts: BackfillOptions): BackfillResult {
  const settings = opts.settings ?? loadObserveSettings();
  const journal = opts.journal ?? new Journal();
  const result: BackfillResult = { imported: [], skipped: [] };

  for (const file of findTranscripts(opts.sinceMs, opts.transcriptsRoot)) {
    let lines: TranscriptLine[];
    try {
      lines = readFileSync(file, "utf-8")
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l) as TranscriptLine;
          } catch {
            return {};
          }
        });
    } catch {
      result.skipped.push({ file, reason: "unreadable" });
      continue;
    }
    const payloads = transcriptToPayloads(lines);
    if (!payloads.some((p) => p.session_id && p.cwd)) {
      result.skipped.push({ file, reason: "no session id or cwd" });
      continue;
    }
    // A session can start in one folder and move into a repository later, so the
    // session belongs to the first enabled repository it worked in, not to its first cwd.
    const first = payloads.find((p) => p.session_id && p.cwd && repoPolicy(p.cwd, settings).enabled);
    if (!first?.session_id || !first.cwd) {
      result.skipped.push({ file, reason: "repository not enabled for observation" });
      continue;
    }
    const policy = repoPolicy(first.cwd, settings);
    if (journal.exists(first.session_id) && !opts.force) {
      result.skipped.push({ file, reason: "already in the journal" });
      continue;
    }
    if (opts.force) journal.remove(first.session_id);

    let events = 0;
    for (const payload of payloads) {
      // No live side effects during import: no workers, no notifications.
      const r = capturePayload(JSON.stringify(payload), { settings: { ...settings, observer: "off", notify: false, question: false }, journal });
      events += r.recorded.length;
    }
    result.imported.push({ session: first.session_id, repo: policy.repo!, events });
  }
  return result;
}

/** Parse "30d", "12h", "2w" into milliseconds. */
export function parseDuration(spec: string): number {
  const m = /^(\d+)\s*([hdw])$/i.exec(spec.trim());
  if (!m) throw new Error(`Invalid duration "${spec}" — use e.g. 30d, 12h, 2w`);
  const n = Number(m[1]);
  return n * { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[m[2].toLowerCase() as "h" | "d" | "w"];
}
