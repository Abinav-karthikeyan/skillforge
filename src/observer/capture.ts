import { appendFileSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { logsDir } from "../config/paths.js";
import { detect, Signal } from "./detectors.js";
import { Journal, JournalEvent } from "./journal.js";
import { ClaudeCodePayload, normalizeClaudeCode, NormalizedEvent } from "./normalize.js";
import { loadObserveSettings, ObserveSettings, repoPolicy } from "./settings.js";
import { spawnDetachedWorker } from "./spawn.js";

/**
 * The capture hot path (plan_v3 §3.3): parse the hook payload, check the repo
 * is opted in, normalize + redact, append to the journal, run the boundary
 * detectors, and — at a milestone — spawn a detached observer. No LLM call, no
 * SDK import, never blocks the host, never throws.
 */
export type HostNormalizer = (payload: unknown) => NormalizedEvent[];

export interface CaptureOptions {
  host?: string;
  /** Payload → events for `host`. Defaults to Claude Code's normalizer. */
  normalize?: HostNormalizer;
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
  /** JSON to print on stdout for the host (systemMessage / additionalContext). */
  output?: Record<string, unknown>;
  skipped?: string;
}

interface CommonPayload {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  hook_event_name?: string;
}

const MAX_PENDING_SIGNALS = 50;

export function capturePayload(raw: string, opts: CaptureOptions = {}): CaptureResult {
  const result: CaptureResult = { recorded: [], signals: [], spawned: [] };
  let payload: CommonPayload;
  try {
    payload = JSON.parse(raw) as CommonPayload;
  } catch {
    return { ...result, skipped: "unparseable payload" };
  }
  if (!payload || typeof payload !== "object") return { ...result, skipped: "unparseable payload" };

  const host = opts.host ?? "claude-code";
  const settings = opts.settings ?? loadObserveSettings();
  const policy = repoPolicy(payload.cwd ?? process.cwd(), settings);
  if (!policy.enabled) return { ...result, skipped: "observation not enabled for this repository" };

  const now = (opts.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const sessionId = payload.session_id || `${host}-${nowIso.slice(0, 10)}`;
  const journal = opts.journal ?? new Journal();
  const spawn = opts.spawn ?? spawnDetachedWorker;
  const normalize = opts.normalize ?? ((p: unknown) => normalizeClaudeCode(p as ClaudeCodePayload));

  const release = journal.lockState(sessionId);
  try {
    const state = journal.loadState(sessionId) ?? journal.newState(sessionId, host, policy.repo, policy.confidential, nowIso);
    if (payload.transcript_path) state.transcript_path = payload.transcript_path;

    let transcriptOffset: number | undefined;
    if (payload.transcript_path) {
      try {
        transcriptOffset = statSync(payload.transcript_path).size;
      } catch {
        /* transcript may lag or be absent */
      }
    }

    const normalized = normalize(payload);
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
        ...(transcriptOffset !== undefined && payload.transcript_path
          ? { transcript_ref: { path: payload.transcript_path, offset: transcriptOffset, length: 0 } }
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
            hookEventName: payload.hook_event_name ?? "Stop",
            additionalContext:
              "skill-forge (question mode, at most once per session): when it fits naturally, ask the user ONE short " +
              "question — what drove the decision they described earlier (the alternatives they weighed and why this one won)? " +
              "Accept a one-line answer and continue; don't record it yourself.",
          },
        };
      }
    }

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
  const hostIdx = argv.indexOf("--host");
  const host = hostIdx !== -1 ? argv[hostIdx + 1] : "claude-code";
  let output = "";
  try {
    const raw = await readStdin(1_500);
    const started = process.hrtime.bigint();
    const result = capturePayload(raw, { host });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (process.env.SKILL_FORGE_OBSERVE_TIMING) log("observe-timing.log", `${ms.toFixed(2)}ms ${result.recorded.length} event(s)`);
    if (result.output) output = JSON.stringify(result.output);
  } catch (err) {
    log("observe.log", `capture error: ${(err as Error).message}`);
  }
  if (output) process.stdout.write(output + "\n", () => process.exit(0));
  else process.exit(0);
}
