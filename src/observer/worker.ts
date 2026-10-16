import { z } from "zod";
import { callClaude } from "../claude/client.js";
import { LLMClient } from "../claude/types.js";
import { loadCalibration } from "../config/calibration.js";
import { resolveArtifactsDir } from "../config/paths.js";
import { StoryLedger } from "../ledger/store.js";
import { interpolate, loadPrompt } from "../translators/base.js";
import { CalibrationConfig } from "../types/config.js";
import { Evidence } from "../types/evidence.js";
import { Observation, ObservationKindSchema } from "../types/ledger.js";
import { Journal, JournalEvent, SessionState } from "./journal.js";
import { CONFIDENTIAL_BLOCK, createObserverClient, safeJson } from "./llm.js";
import { loadObserveSettings, ObserveSettings } from "./settings.js";

/**
 * The warm path (plan_v3 §3.3): a detached worker reads the journal since the
 * session's watermark, asks a cheap model for cited, claim-sized
 * observations, and persists them — with event-level evidence — to the story
 * ledger. One worker per session at a time (lockfile), debounced and capped
 * per hour by the capture side.
 */
export interface WorkerDeps {
  journal?: Journal;
  ledger?: StoryLedger;
  config?: CalibrationConfig;
  settings?: ObserveSettings;
  /** Overrides the observer model (tests, or a caller that already has one). */
  client?: LLMClient;
  now?: () => Date;
}

export interface ResolvedDeps {
  journal: Journal;
  ledger: StoryLedger;
  config: CalibrationConfig;
  settings: ObserveSettings;
  now: () => Date;
  clientFor(confidential: boolean): LLMClient;
}

export function resolveDeps(deps: WorkerDeps = {}): ResolvedDeps {
  const config = deps.config ?? loadCalibration();
  return {
    journal: deps.journal ?? new Journal(),
    ledger: deps.ledger ?? StoryLedger.forArtifactsDir(resolveArtifactsDir(config.output_dir)),
    config,
    settings: deps.settings ?? loadObserveSettings(),
    now: deps.now ?? (() => new Date()),
    clientFor: (confidential) => deps.client ?? createObserverClient(config, confidential),
  };
}

const ObserverResponseSchema = z.object({
  observations: z
    .array(
      z.object({
        kind: ObservationKindSchema,
        claim: z.string().min(1),
        evidence: z.array(z.string()).default([]),
        confidence: z.number().min(0).max(1),
      })
    )
    .default([]),
});

const MAX_LOG_CHARS = 24_000;

/** One line per event for the observer prompt. */
export function describeEvent(e: JournalEvent, max = 400): string {
  const p = e.payload;
  const s = (v: unknown, n = max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
  switch (e.kind) {
    case "prompt":
      return `[${e.id} user prompt] ${s(p.text, 1_200)}`;
    case "test_run":
      return `[${e.id} test ${p.runner} ${p.passed ? "PASS" : `FAIL${p.exit_code !== undefined ? ` exit ${p.exit_code}` : ""}`}] ${s(p.command, 160)}${p.passed ? "" : ` → ${s(p.output, 300)}`}`;
    case "commit":
      return `[${e.id} commit${p.sha ? ` ${String(p.sha).slice(0, 7)}` : ""}] ${s(p.message) || s(p.command, 200)}`;
    case "file_edit":
      return `[${e.id} ${p.op === "create" ? "created" : "edited"}] ${s(p.path, 200)}`;
    case "tool_result": {
      const effects = [
        Array.isArray(p.installed) ? `installed ${(p.installed as string[]).join(", ")}` : "",
        Array.isArray(p.deleted_paths) ? `deleted ${(p.deleted_paths as string[]).join(", ")}` : "",
        Array.isArray(p.reverted_paths) ? `reverted ${(p.reverted_paths as string[]).join(", ")}` : "",
      ].filter(Boolean);
      const what = p.command ? s(p.command, 200) : s(p.target, 200);
      const err = p.ok === false ? ` → FAILED: ${s(p.error ?? p.output, 200)}` : "";
      return `[${e.id} ${p.tool}${p.ok === false ? " failed" : ""}] ${what}${effects.length ? ` (${effects.join("; ")})` : ""}${err}`;
    }
    case "turn_end":
      return `[${e.id} assistant${p.agent_type ? ` (${p.agent_type})` : ""}] ${s(p.message, 600)}`;
    case "compaction":
      return p.phase === "post"
        ? `[${e.id} compaction summary] ${s(p.summary, 2_000)}`
        : `[${e.id} compaction starting (${p.trigger})]`;
    case "session_start":
      return `[${e.id} session ${p.source ?? "start"}]`;
    case "session_end":
      return `[${e.id} session end (${p.reason})]`;
    default:
      return `[${e.id} ${e.kind}]`;
  }
}

/**
 * Render events within a character budget. When over budget, keep the events
 * the detector signals point at plus the most recent ones — the tail is where
 * the session is now, the signals are where its stories are.
 */
export function renderEventLog(events: JournalEvent[], pinned: Set<string>, maxChars = MAX_LOG_CHARS): string {
  const lines = events.map((e) => ({ id: e.id, line: describeEvent(e) }));
  const total = lines.reduce((n, l) => n + l.line.length + 1, 0);
  if (total <= maxChars) return lines.map((l) => l.line).join("\n");
  const keep = new Set<string>();
  let used = 0;
  for (const l of lines) {
    if (pinned.has(l.id)) {
      keep.add(l.id);
      used += l.line.length + 1;
    }
  }
  for (let i = lines.length - 1; i >= 0 && used < maxChars; i--) {
    if (keep.has(lines[i].id)) continue;
    if (used + lines[i].line.length + 1 > maxChars) break;
    keep.add(lines[i].id);
    used += lines[i].line.length + 1;
  }
  const out: string[] = [];
  let gap = 0;
  for (const l of lines) {
    if (keep.has(l.id)) {
      if (gap) out.push(`[… ${gap} earlier event(s) omitted …]`);
      gap = 0;
      out.push(l.line);
    } else gap++;
  }
  return out.join("\n");
}

export function evidenceForEvent(e: JournalEvent, journalPath: string, now: string): Evidence {
  return {
    id: `ev-${e.session_id}-${e.id}`,
    kind: e.kind === "commit" ? "commit" : "event",
    source: {
      provider: `journal:${e.host}`,
      path: journalPath,
      symbol: e.id,
      ...(e.kind === "commit" && typeof e.payload.sha === "string" ? { sha: e.payload.sha } : {}),
      retrieved_at: now,
    },
    summary: describeEvent(e, 160).slice(0, 240),
    confidence: 1,
  };
}

export interface ObserverPassResult {
  observations: Observation[];
  skipped?: string;
}

export async function runObserverPass(
  sessionId: string,
  deps: WorkerDeps & { force?: boolean } = {}
): Promise<ObserverPassResult> {
  const d = resolveDeps(deps);
  const state = d.journal.loadState(sessionId);
  if (!state) return { observations: [], skipped: "unknown session" };

  const release = d.journal.workerLock(sessionId);
  if (!release) return { observations: [], skipped: "another observer is running for this session" };
  try {
    const events = d.journal.readEvents(sessionId, state.observed_through_seq);
    if (events.length === 0) return { observations: [], skipped: "nothing new since the last observation" };
    const nowDate = d.now();
    if (!deps.force && d.journal.observerCallsInLastHour(nowDate.getTime()) >= d.settings.max_observer_calls_per_hour) {
      return { observations: [], skipped: "hourly observer budget spent" };
    }

    const pinned = new Set(state.pending_signals.flatMap((sig) => sig.event_ids));
    const { content: template } = loadPrompt("observer");
    const system = interpolate(template, {
      confidential_block: state.confidential ? CONFIDENTIAL_BLOCK : "",
      signals: state.pending_signals.length
        ? state.pending_signals.map((sig) => `- ${sig.kind}: ${sig.detail} (events ${sig.event_ids.join(", ")})`).join("\n")
        : "(none)",
      events: renderEventLog(events, pinned),
    });

    const client = d.clientFor(state.confidential);
    const ask = "Extract the observations.";
    let parsed = ObserverResponseSchema.safeParse(safeJson(await callClaude(client, system, ask)));
    if (!parsed.success) {
      parsed = ObserverResponseSchema.safeParse(
        safeJson(await callClaude(client, system, `${ask}\n\nYour previous reply was not valid JSON in the required shape. Return ONLY the JSON object.`))
      );
    }
    d.journal.recordObserverCall(nowDate.getTime());
    if (!parsed.success) return { observations: [], skipped: "observer returned unparseable output" };

    const nowIso = nowDate.toISOString();
    const byId = new Map(events.map((e) => [e.id, e]));
    const lastSeq = events[events.length - 1].seq;
    const evidence = new Map<string, Evidence>();
    const observations: Observation[] = [];
    parsed.data.observations.forEach((o, i) => {
      // Grounding rule: an observation must cite at least one real event.
      const cited = [...new Set(o.evidence)].filter((id) => byId.has(id));
      if (cited.length === 0 || o.confidence < 0.5) return;
      const evIds = cited.map((id) => {
        const ev = evidenceForEvent(byId.get(id)!, d.journal.eventsPath(sessionId), nowIso);
        evidence.set(ev.id, ev);
        return ev.id;
      });
      observations.push({
        id: `obs-${sessionId}-${lastSeq}-${i}`,
        session_id: sessionId,
        kind: o.kind,
        claim: o.claim.trim(),
        evidence_ids: evIds,
        confidence: o.confidence,
        ts: nowIso,
      });
    });
    d.ledger.putEvidence([...evidence.values()]);
    d.ledger.appendObservations(observations);

    // Advance the watermark under the state lock (capture may have appended meanwhile).
    const unlock = d.journal.lockState(sessionId, 2_000);
    try {
      const latest: SessionState = d.journal.loadState(sessionId) ?? state;
      latest.observed_through_seq = Math.max(latest.observed_through_seq, lastSeq);
      latest.pending_signals = latest.pending_signals.filter((sig) =>
        sig.event_ids.some((id) => !byId.has(id) && Number(id.slice(1)) > lastSeq)
      );
      latest.detector.tool_events_since_observation = 0;
      latest.observer_runs++;
      latest.last_observer_at = nowIso;
      d.journal.saveState(latest);
    } finally {
      unlock?.();
    }
    return { observations };
  } finally {
    release();
  }
}
