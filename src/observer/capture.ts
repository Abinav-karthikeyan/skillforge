import { appendFileSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { logsDir } from "../config/paths.js";
import { detect, Signal } from "./detectors.js";
import { getHostAdapter } from "./hosts/registry.js";
import type { HostAdapter } from "./hosts/types.js";
import { Journal, JournalEvent } from "./journal.js";
import { loadObserveSettings, normalizeRepoPath, ObserveSettings, repoPolicy } from "./settings.js";
import { spawnDetachedWorker } from "./spawn.js";

/**
 * The capture hot path (plan_v3 §3.3): parse the hook payload with the host's
 * adapter, check the repo is opted in, normalize + redact, append to the
 * journal, run the boundary detectors, and — at a milestone — spawn a detached
 * observer. No LLM call, no SDK import, never blocks the host, never throws.
 */
export interface CaptureOptions {
  /** Host name (see ./hosts/registry.ts). Default: claude-code. */
  host?: string;
  /** Explicit adapter (overrides `host`). */
  adapter?: HostAdapter;
  /** Event name supplied on the command line, for hosts whose payload omits it. */
  eventName?: string;
  settings?: ObserveSettings;
  journal?: Journal;
  now?: () => Date;
  /** Detached worker launcher (injectable for tests). */
  spawn?: (args: string[]) => boolean;
}

export interface CaptureResult {
  recorded: string[];
  signals: Signal[];
  spawned: string[][];
  /** JSON to print on stdout for the host (systemMessage / additionalContext / ack). */
  output?: Record<string, unknown>;
  skipped?: string;
}

const MAX_PENDING_SIGNALS = 50;

/** Journal key: Claude Code ids stay as-is (v3.2 journals); other hosts are namespaced. */
export function journalSessionId(host: string, raw: string | undefined, fallback: string): string {
  const id = raw || fallback;
  return host === "claude-code" ? id : `${host}:${id}`;
}

export function capturePayload(raw: string, opts: CaptureOptions = {}): CaptureResult {
  const result: CaptureResult = { recorded: [], signals: [], spawned: [] };
  let payload: Record<string, unknown>;
  try {
    payload = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return { ...result, skipped: "unparseable payload" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ...result, skipped: "unparseable payload" };
  if (opts.eventName && payload.hook_event_name === undefined) payload.hook_event_name = opts.eventName;

  const adapter = opts.adapter ?? getHostAdapter(opts.host ?? "claude-code");
  if (!adapter) return { ...result, skipped: `unknown host "${opts.host}"` };
  const host = adapter.name;
  const now = (opts.now ?? (() => new Date()))();
  const nowIso = now.toISOString();

  let parsed;
  try {
    parsed = adapter.parse(payload, { cwd: process.cwd(), now });
  } catch {
    parsed = null;
  }
  if (!parsed) return { ...result, skipped: "payload not recognized by the host adapter" };

  const settings = opts.settings ?? loadObserveSettings();
  const policy = repoPolicy(parsed.cwd ?? process.cwd(), settings);
  if (!policy.enabled) return { ...result, output: parsed.ack, skipped: "observation not enabled for this repository" };
  if (parsed.events.length === 0) return { ...result, output: parsed.ack, skipped: "no events in payload" };

  const sessionId = journalSessionId(host, parsed.sessionId, nowIso.slice(0, 10));
  const journal = opts.journal ?? new Journal();
  const spawn = opts.spawn ?? spawnDetachedWorker;
  const transcriptPath = parsed.transcriptPath;
  const repoKey = normalizeRepoPath(policy.repo!);

  // Commit dedupe across hosts: the same commit may arrive from an agent's
  // tool hook and from git's post-commit. First writer keeps the checkpoint.
  const normalized = parsed.events.flatMap((n) => {
    const sha = n.kind === "commit" && typeof n.payload.sha === "string" ? (n.payload.sha as string) : undefined;
    if (!sha) return [n];
    const owner = journal.commitOwner(repoKey, sha);
    if (owner && owner !== sessionId) {
      return host === "git" ? [] : [{ ...n, kind: "tool_result" as const, payload: { ...n.payload, duplicate_of: owner } }];
    }
    journal.registerCommit(repoKey, sha, sessionId);
    return [n];
  });
  if (normalized.length === 0) return { ...result, output: parsed.ack, skipped: "commit already observed by another session" };

  const release = journal.lockState(sessionId);
  try {
    const state = journal.loadState(sessionId) ?? journal.newState(sessionId, host, policy.repo, policy.confidential, nowIso);
    if (transcriptPath) state.transcript_path = transcriptPath;

    let transcriptOffset: number | undefined;
    if (transcriptPath) {
      try {
        transcriptOffset = statSync(transcriptPath).size;
      } catch {
        /* transcript may lag or be absent */
      }
    }

    const events: JournalEvent[] = normalized.map((n) => {
      const seq = ++state.seq;
      return {
        id: `e${seq}`,
        seq,
        host,
        session_id: sessionId,
        ...(n.agent_id ? { agent_id: n.agent_id } : {}),
        ts: nowIso,
        kind: n.kind,
        payload: n.payload,
        ...(transcriptOffset !== undefined && transcriptPath
          ? { transcript_ref: { path: transcriptPath, offset: transcriptOffset, length: 0 } }
          : {}),
        redacted: true as const,
      };
    });
    journal.append(events);
    result.recorded = events.map((e) => e.id);

    for (const e of events) {
      result.signals.push(...detect(e, state.detector, settings));
    }
    state.pending_signals = [...state.pending_signals, ...result.signals].slice(-MAX_PENDING_SIGNALS);

    const kinds = new Set(events.map((e) => e.kind));
    if (kinds.has("session_end")) state.ended = true;

    // ── warm / cold path triggers ──────────────────────────────────────────
    if (settings.observer === "auto") {
      const launch = (args: string[]) => {
        if (spawn(args)) result.spawned.push(args);
      };
      if (kinds.has("session_end")) {
        // Cold path: observe whatever is left, then reflect. Detached — the
        // host's SessionEnd budget is ~1.5 s.
        launch(["--session", sessionId, "--reflect"]);
        state.last_observer_at = nowIso;
      } else {
        const snapshot = result.signals.some((s) => s.kind === "snapshot");
        const milestone = result.signals.some((s) => s.milestone);
        const sinceLast = state.last_observer_at ? now.getTime() - Date.parse(state.last_observer_at) : Infinity;
        const debounced = sinceLast < settings.observer_min_interval_s * 1000;
        const overBudget = journal.observerCallsInLastHour(now.getTime()) >= settings.max_observer_calls_per_hour;
        if (snapshot || (milestone && !debounced && !overBudget)) {
          launch(["--session", sessionId, ...(snapshot ? ["--force"] : [])]);
          // Claim the slot now so parallel hook processes don't spawn twins.
          state.last_observer_at = nowIso;
        }
      }
      if (kinds.has("session_start")) {
        // Catch up on sessions that ended (or crashed) without a finished reflection.
        const stale = journal
          .allStates()
          .some(
            (s) =>
              s.session_id !== sessionId &&
              s.reflected_through_seq < s.seq &&
              (s.ended || now.getTime() - Date.parse(s.updated_at) > 6 * 3_600_000)
          );
        if (stale) launch(["--catch-up"]);
      }
    }

    // ── interaction contract: notify / question ────────────────────────────
    if (kinds.has("session_start") && settings.notify) {
      const n = journal.readInboxCount();
      if (n > 0) {
        result.output = {
          systemMessage: `skill-forge: ${n} story candidate${n === 1 ? "" : "s"} waiting for review — run /skill-forge-review or \`skill-forge inbox\`.`,
        };
      }
    }
    if (kinds.has("turn_end") && settings.question && !state.question_asked) {
      const candidate = state.pending_signals.find((s) => s.kind === "tradeoff_candidate");
      if (candidate) {
        state.question_asked = true;
        result.output = {
          hookSpecificOutput: {
            hookEventName: typeof payload.hook_event_name === "string" ? payload.hook_event_name : "Stop",
            additionalContext:
              "skill-forge (question mode, at most once per session): when it fits naturally, ask the user ONE short " +
              "question — what drove the decision they described earlier (the alternatives they weighed and why this one won)? " +
              "Accept a one-line answer and continue; don't record it yourself.",
          },
        };
      }
    }

    result.output ??= parsed.ack;
    state.updated_at = nowIso;
    journal.saveState(state);
    return result;
  } finally {
    release?.();
  }
}

function log(file: string, line: string): void {
  try {
    const dir = logsDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, file), `${new Date().toISOString()} ${line}\n`, "utf-8");
  } catch {
    /* never throw from a hook */
  }
}

function readStdin(timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/** `skill-forge-observe [--host <name>]` — the hook entry point. Always exits 0. */
export async function runCaptureMain(argv: string[]): Promise<void> {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const host = arg("--host") ?? "claude-code";
  const eventName = arg("--event");
  let output = "";
  try {
    const raw = await readStdin(1_500);
    const started = process.hrtime.bigint();
    const result = capturePayload(raw, { host, eventName });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (process.env.SKILL_FORGE_OBSERVE_TIMING) log("observe-timing.log", `${ms.toFixed(2)}ms ${result.recorded.length} event(s)`);
    if (result.output) output = JSON.stringify(result.output);
  } catch (err) {
    log("observe.log", `capture error: ${(err as Error).message}`);
  }
  if (output) process.stdout.write(output + "\n", () => process.exit(0));
  else process.exit(0);
}
