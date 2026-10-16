import { execFileSync } from "child_process";
import { transcriptToPayloads } from "../backfill.js";
import { capturePayload } from "../capture.js";
import { claudeCodeAdapter } from "../hosts/claude-code.js";
import { onPath } from "../hosts/shared.js";
import { Journal } from "../journal.js";
import { loadObserveSettings, ObserveSettings, repoPolicy } from "../settings.js";

/**
 * Entire CLI checkpoints (docs.entire.io) as an observer input. [unverified]
 * Entire's on-disk layout depends on its storage backend (branch-based
 * `entire/checkpoints/v1` vs per-checkpoint refs) and its metadata schema is
 * not published, so this importer only uses Entire's own CLI:
 *
 *   entire checkpoint list --json                     (documented: machine-readable listing)
 *   entire checkpoint explain <id> --raw-transcript   (documented: the JSONL transcript)
 *
 * Listing fields are read tolerantly. Transcripts in Claude Code's JSONL
 * format are replayed through the normal capture path; other agents'
 * transcript formats are skipped and reported.
 */
export type Exec = (cmd: string, args: string[], cwd: string) => string;

const defaultExec: Exec = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf-8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, shell: process.platform === "win32" });

export interface EntireCheckpoint {
  id: string;
  session?: string;
  commit?: string;
  agent?: string;
  created_at?: string;
}

const pick = (o: Record<string, unknown>, keys: string[]) =>
  keys.map((k) => o[k]).find((v): v is string => typeof v === "string" && v.length > 0);

export function parseCheckpointList(json: string): EntireCheckpoint[] {
  const parsed = JSON.parse(json) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? ((parsed as Record<string, unknown>).checkpoints ?? (parsed as Record<string, unknown>).items ?? [])
      : [];
  return (list as Array<Record<string, unknown>>)
    .map((c) => ({
      id: pick(c, ["id", "checkpoint_id", "checkpointId", "checkpoint"]) ?? "",
      session: pick(c, ["session_id", "sessionId", "session"]),
      commit: pick(c, ["commit", "commit_sha", "commitSha", "sha", "commit_hash"]),
      agent: pick(c, ["agent", "agent_name", "agentName"]),
      created_at: pick(c, ["created_at", "createdAt", "timestamp", "time"]),
    }))
    .filter((c) => c.id);
}

export interface EntireImportResult {
  imported: Array<{ checkpoint: string; session: string; events: number }>;
  skipped: Array<{ checkpoint: string; reason: string }>;
}

export function importEntireCheckpoints(opts: {
  cwd?: string;
  limit?: number;
  exec?: Exec;
  settings?: ObserveSettings;
  journal?: Journal;
}): EntireImportResult {
  const cwd = opts.cwd ?? process.cwd();
  const exec = opts.exec ?? defaultExec;
  const settings = opts.settings ?? loadObserveSettings();
  const journal = opts.journal ?? new Journal();
  const result: EntireImportResult = { imported: [], skipped: [] };

  if (!opts.exec && !onPath("entire")) throw new Error("The `entire` CLI is not on PATH (https://docs.entire.io).");
  const policy = repoPolicy(cwd, settings);
  if (!policy.enabled) throw new Error("Observation is not enabled for this repository (`skill-forge observe enable`).");

  const checkpoints = parseCheckpointList(exec("entire", ["checkpoint", "list", "--json"], cwd)).slice(0, opts.limit ?? 50);
  for (const cp of checkpoints) {
    const sessionId = `entire:${cp.session ?? cp.id}`;
    if (journal.exists(sessionId)) {
      result.skipped.push({ checkpoint: cp.id, reason: "already imported" });
      continue;
    }
    let raw: string;
    try {
      raw = exec("entire", ["checkpoint", "explain", cp.id, "--raw-transcript"], cwd);
    } catch (err) {
      result.skipped.push({ checkpoint: cp.id, reason: `explain failed: ${(err as Error).message.split("\n")[0]}` });
      continue;
    }
    const lines = raw
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return {};
        }
      });
    const claudeShaped = lines.some((l) => (l.type === "user" || l.type === "assistant") && l.message);
    if (!claudeShaped) {
      result.skipped.push({ checkpoint: cp.id, reason: `unsupported transcript format${cp.agent ? ` (${cp.agent})` : ""}` });
      continue;
    }

    const payloads = transcriptToPayloads(lines).map((p) => ({ ...p, session_id: sessionId, cwd }));
    if (cp.commit) {
      // The checkpoint *is* a commit; record it so it dedupes with git/agent hooks.
      payloads.splice(Math.max(0, payloads.length - 1), 0, {
        session_id: sessionId,
        cwd,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "git commit (Entire checkpoint)" },
        tool_response: { stdout: `[entire ${cp.commit.slice(0, 12)}] checkpoint ${cp.id}` },
      });
    }
    let events = 0;
    for (const p of payloads) {
      const r = capturePayload(JSON.stringify(p), {
        adapter: claudeCodeAdapter,
        settings: { ...settings, observer: "off", notify: false, question: false },
        journal,
      });
      events += r.recorded.length;
    }
    result.imported.push({ checkpoint: cp.id, session: sessionId, events });
  }
  return result;
}
