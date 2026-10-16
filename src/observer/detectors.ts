import type { ObservedEventKind } from "../types/ledger.js";

/**
 * Deterministic boundary detectors (plan_v3 §3.3). They run at capture time,
 * cost nothing, and decide when the (LLM) observer is worth waking. Each
 * signal names the journal events it is built from, so observations can cite
 * them.
 */
export type SignalKind =
  | "debug_arc" //            test runner failed ≥N times, then passed
  | "dead_end" //             created-then-deleted file, reverted edits, hard reset
  | "dependency" //           package installed / manifest edited
  | "tradeoff_candidate" //   decision language in a prompt
  | "checkpoint" //           git commit
  | "snapshot" //             compaction is about to drop context
  | "flush"; //               many tool events since the last observation

export interface Signal {
  kind: SignalKind;
  event_ids: string[];
  detail: string;
  /** Milestones wake the observer (subject to debounce and budget). */
  milestone: boolean;
  ts: string;
}

export interface DetectorState {
  /** Per test runner: consecutive failures since its last pass. */
  test_failures: Record<string, { count: number; event_ids: string[]; last_error?: string }>;
  /** Files created this session → creating event id. */
  created_files: Record<string, string>;
  /** Files edited this session → event ids. */
  edited_files: Record<string, string[]>;
  tool_events_since_observation: number;
}

export const emptyDetectorState = (): DetectorState => ({
  test_failures: {},
  created_files: {},
  edited_files: {},
  tool_events_since_observation: 0,
});

export interface DetectorEvent {
  id: string;
  kind: ObservedEventKind;
  ts: string;
  payload: Record<string, unknown>;
}

export interface DetectorConfig {
  debug_arc_min_failures: number;
  flush_after_tool_calls: number;
}

/** Decision language that marks a tradeoff worth asking about. */
export const DECISION_LANGUAGE =
  /\b(instead of|rather than|why not|let'?s (?:go with|use|switch)|go with|trade-?offs?|pros and cons|versus|vs\.?|switch(?:ed|ing)? (?:from|to)|alternatives?|better approach|should (?:we|i) use)\b/i;

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

/** Does a deleted/reverted path refer to a path we saw (absolute vs relative tolerant)? */
function samePath(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return x === y || x.endsWith("/" + y) || y.endsWith("/" + x);
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

export function detect(event: DetectorEvent, state: DetectorState, cfg: DetectorConfig): Signal[] {
  const signals: Signal[] = [];
  const emit = (kind: SignalKind, event_ids: string[], detail: string, milestone: boolean) =>
    signals.push({ kind, event_ids, detail, milestone, ts: event.ts });
  const p = event.payload;

  if (event.kind === "tool_result" || event.kind === "test_run" || event.kind === "file_edit" || event.kind === "commit") {
    state.tool_events_since_observation++;
  }

  switch (event.kind) {
    case "test_run": {
      const runner = String(p.runner ?? "test");
      const entry = (state.test_failures[runner] ??= { count: 0, event_ids: [] });
      if (p.passed === false) {
        entry.count++;
        entry.event_ids.push(event.id);
        entry.event_ids = entry.event_ids.slice(-8);
        if (typeof p.output === "string") entry.last_error = p.output.slice(0, 300);
      } else {
        if (entry.count >= cfg.debug_arc_min_failures) {
          emit("debug_arc", [...entry.event_ids, event.id], `${runner} failed ${entry.count}× before passing`, true);
        }
        delete state.test_failures[runner];
      }
      break;
    }
    case "file_edit": {
      const path = String(p.path ?? "");
      if (!path) break;
      if (p.op === "create" && !state.edited_files[path]) state.created_files[path] = event.id;
      (state.edited_files[path] ??= []).push(event.id);
      state.edited_files[path] = state.edited_files[path].slice(-6);
      if (p.manifest) emit("dependency", [event.id], `edited dependency manifest ${path}`, false);
      break;
    }
    case "commit":
      emit("checkpoint", [event.id], `commit${p.sha ? ` ${String(p.sha).slice(0, 7)}` : ""}${p.message ? `: ${p.message}` : ""}`, true);
      break;
    case "compaction":
      if (p.phase === "pre") emit("snapshot", [event.id], `context compaction (${p.trigger ?? "auto"})`, true);
      break;
    case "prompt": {
      const prompt = String(p.text ?? "");
      const m = DECISION_LANGUAGE.exec(prompt);
      if (m) emit("tradeoff_candidate", [event.id], `decision language: "${m[0]}"`, true);
      break;
    }
    case "turn_end":
      if (state.tool_events_since_observation >= cfg.flush_after_tool_calls) {
        emit("flush", [event.id], `${state.tool_events_since_observation} tool events since the last observation`, true);
      }
      break;
  }

  // Shell effects ride on tool_result / test_run payloads.
  const installs = strings(p.installed);
  if (installs.length) emit("dependency", [event.id], `installed ${installs.join(", ")}`, false);

  for (const deleted of strings(p.deleted_paths)) {
    const created = Object.keys(state.created_files).find((c) => samePath(c, deleted));
    if (created) {
      emit("dead_end", [state.created_files[created], event.id], `created ${created} then deleted it`, true);
      delete state.created_files[created];
    }
  }
  for (const reverted of strings(p.reverted_paths)) {
    if (reverted === "*") {
      const touched = Object.keys(state.edited_files);
      if (touched.length) {
        emit("dead_end", [...touched.flatMap((f) => state.edited_files[f].slice(-1)), event.id].slice(-6), `discarded working changes to ${touched.length} file(s)`, true);
      }
      continue;
    }
    const edited = Object.keys(state.edited_files).find((e) => samePath(e, reverted));
    if (edited) emit("dead_end", [...state.edited_files[edited].slice(-3), event.id], `reverted edits to ${edited}`, true);
  }

  return signals;
}
