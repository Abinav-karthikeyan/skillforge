import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { journalDir } from "../config/paths.js";
import { safeFileStem, writeFileAtomic } from "../util/fs.js";
import type { ObservedEventKind } from "../types/ledger.js";
import { DetectorState, emptyDetectorState, Signal } from "./detectors.js";

/**
 * The observer journal (plan_v3 §3.3): `<dir>/<session>.jsonl` holds redacted
 * events, `<session>.state.json` holds counters, detector state, pending
 * signals, and watermarks. Plain files, per-session, so parallel sessions
 * never contend; a short lock serializes concurrent hook processes of the same
 * session (Claude Code runs async hooks in parallel).
 */
export interface JournalEvent {
  id: string;
  seq: number;
  host: string;
  session_id: string;
  agent_id?: string;
  ts: string;
  kind: ObservedEventKind;
  payload: Record<string, unknown>;
  /** Byte watermark into the host transcript when the event was captured. */
  transcript_ref?: { path: string; offset: number; length: number };
  redacted: true;
}

export interface SessionState {
  session_id: string;
  host: string;
  repo: string | null;
  confidential: boolean;
  transcript_path?: string;
  seq: number;
  created_at: string;
  updated_at: string;
  detector: DetectorState;
  /** Signals not yet consumed by an observer pass. */
  pending_signals: Signal[];
  observed_through_seq: number;
  last_observer_at?: string;
  observer_runs: number;
  reflected_through_seq: number;
  ended: boolean;
  question_asked: boolean;
}

export class Journal {
  constructor(readonly dir: string = journalDir()) {}

  private base(sessionId: string): string {
    return join(this.dir, safeFileStem(sessionId));
  }
  eventsPath(sessionId: string): string {
    return this.base(sessionId) + ".jsonl";
  }
  statePath(sessionId: string): string {
    return this.base(sessionId) + ".state.json";
  }

  exists(sessionId: string): boolean {
    return existsSync(this.statePath(sessionId));
  }

  loadState(sessionId: string): SessionState | null {
    try {
      return JSON.parse(readFileSync(this.statePath(sessionId), "utf-8")) as SessionState;
    } catch {
      return null;
    }
  }

  newState(sessionId: string, host: string, repo: string | null, confidential: boolean, now: string): SessionState {
    return {
      session_id: sessionId,
      host,
      repo,
      confidential,
      seq: 0,
      created_at: now,
      updated_at: now,
      detector: emptyDetectorState(),
      pending_signals: [],
      observed_through_seq: 0,
      observer_runs: 0,
      reflected_through_seq: 0,
      ended: false,
      question_asked: false,
    };
  }

  saveState(state: SessionState): void {
    writeFileAtomic(this.statePath(state.session_id), JSON.stringify(state));
  }

  append(events: JournalEvent[]): void {
    if (events.length === 0) return;
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.eventsPath(events[0].session_id), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  }

  readEvents(sessionId: string, afterSeq = 0): JournalEvent[] {
    const path = this.eventsPath(sessionId);
    if (!existsSync(path)) return [];
    const out: JournalEvent[] = [];
    for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as JournalEvent;
        if (e.seq > afterSeq) out.push(e);
      } catch {
        // torn trailing line
      }
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  sessions(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((n) => n.endsWith(".state.json"))
      .map((n) => this.loadStateFile(join(this.dir, n))?.session_id)
      .filter((s): s is string => Boolean(s));
  }

  private loadStateFile(path: string): SessionState | null {
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as SessionState;
    } catch {
      return null;
    }
  }

  allStates(): SessionState[] {
    return this.sessions()
      .map((s) => this.loadState(s))
      .filter((s): s is SessionState => s !== null);
  }

  /** Delete a session's raw journal and state (plan_v3 §3.4 `forget`). */
  remove(sessionId: string): void {
    for (const p of [this.eventsPath(sessionId), this.statePath(sessionId), this.base(sessionId) + ".worker.lock"]) {
      rmSync(p, { force: true });
    }
  }

  /** TTL purge of raw journals. Returns the sessions removed. */
  purge(retentionDays: number, now = Date.now()): string[] {
    const cutoff = now - retentionDays * 86_400_000;
    const removed: string[] = [];
    for (const state of this.allStates()) {
      let mtime = 0;
      try {
        mtime = statSync(this.statePath(state.session_id)).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < cutoff) {
        this.remove(state.session_id);
        removed.push(state.session_id);
      }
    }
    return removed;
  }

  // ── locks ────────────────────────────────────────────────────────────────

  /**
   * Exclusive lock file. Returns a release function, or null if held by
   * someone else (stale locks older than `staleMs` are stolen).
   */
  tryLock(name: string, staleMs: number): (() => void) | null {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, name);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, "wx");
        writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        closeSync(fd);
        return () => rmSync(path, { force: true });
      } catch {
        try {
          if (Date.now() - statSync(path).mtimeMs > staleMs) {
            rmSync(path, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        return null;
      }
    }
    return null;
  }

  /** Spin briefly for the per-session state lock (hook processes are short). */
  lockState(sessionId: string, waitMs = 300): (() => void) | null {
    const name = safeFileStem(sessionId) + ".state.lock";
    const deadline = Date.now() + waitMs;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      const release = this.tryLock(name, 5_000);
      if (release) return release;
      if (Date.now() > deadline) return null;
      Atomics.wait(pause, 0, 0, 5);
    }
  }

  workerLock(sessionId: string): (() => void) | null {
    return this.tryLock(safeFileStem(sessionId) + ".worker.lock", 15 * 60_000);
  }

  // ── observer budget (global, per hour) ────────────────────────────────────

  private budgetPath(): string {
    return join(this.dir, "_observer_budget.json");
  }

  observerCallsInLastHour(now = Date.now()): number {
    try {
      const calls = JSON.parse(readFileSync(this.budgetPath(), "utf-8")) as number[];
      return calls.filter((t) => now - t < 3_600_000).length;
    } catch {
      return 0;
    }
  }

  recordObserverCall(now = Date.now()): void {
    let calls: number[] = [];
    try {
      calls = JSON.parse(readFileSync(this.budgetPath(), "utf-8")) as number[];
    } catch {
      /* first call */
    }
    calls = [...calls.filter((t) => now - t < 3_600_000), now];
    writeFileAtomic(this.budgetPath(), JSON.stringify(calls));
  }

  // ── inbox counter (written by the reflector, read by capture) ────────────

  private inboxPath(): string {
    return join(this.dir, "_inbox.json");
  }

  readInboxCount(): number {
    try {
      return (JSON.parse(readFileSync(this.inboxPath(), "utf-8")) as { candidates: number }).candidates ?? 0;
    } catch {
      return 0;
    }
  }

  writeInboxCount(candidates: number): void {
    writeFileAtomic(this.inboxPath(), JSON.stringify({ candidates, updated_at: new Date().toISOString() }));
  }
}
