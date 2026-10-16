import { createHash } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { basename, join } from "path";
import { ledgerDirFor } from "../config/paths.js";
import { Evidence, EvidenceSchema } from "../types/evidence.js";
import {
  Observation,
  ObservationSchema,
  Story,
  StoryArtifact,
  StorySchema,
  StoryStatus,
} from "../types/ledger.js";
import { SessionSummary, TranslatorOutput } from "../types/session.js";
import { safeFileStem, writeFileAtomic } from "../util/fs.js";

/**
 * The story ledger: JSON per story, JSONL for observations and evidence.
 * Plain files on purpose (plan_v3 §5: "no vector store"; SQLite only if
 * measured scale demands it).
 *
 *   <ledger>/stories/<id>.json            current Story
 *   <ledger>/stories/<id>.history.jsonl   one line per superseded version
 *   <ledger>/observations/<session>.jsonl
 *   <ledger>/evidence.jsonl               append-only; last write per id wins
 */
export class StoryLedger {
  constructor(readonly dir: string) {}

  static forArtifactsDir(artifactsDir: string): StoryLedger {
    return new StoryLedger(ledgerDirFor(artifactsDir));
  }

  // ── stories ─────────────────────────────────────────────────────────────

  private storiesDir(): string {
    return join(this.dir, "stories");
  }

  private storyPath(id: string): string {
    return join(this.storiesDir(), `${safeFileStem(id)}.json`);
  }

  private historyPath(id: string): string {
    return join(this.storiesDir(), `${safeFileStem(id)}.history.jsonl`);
  }

  get(storyId: string): Story | null {
    const path = this.storyPath(storyId);
    if (!existsSync(path)) return null;
    return StorySchema.parse(JSON.parse(readFileSync(path, "utf-8")));
  }

  /** All stories, oldest update first. Unreadable files are skipped, not fatal. */
  list(): Story[] {
    const dir = this.storiesDir();
    if (!existsSync(dir)) return [];
    const stories: Story[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        stories.push(StorySchema.parse(JSON.parse(readFileSync(join(dir, name), "utf-8"))));
      } catch {
        // A corrupt story file must not hide the rest of the ledger.
      }
    }
    return stories.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  }

  /**
   * Persist a story. When it supersedes a stored story at a lower version,
   * the stored one is appended to the history file first, so every version
   * stays diffable.
   */
  put(story: Story): Story {
    const validated = StorySchema.parse(story);
    const previous = this.get(validated.story_id);
    if (previous && validated.version > previous.version) {
      mkdirSync(this.storiesDir(), { recursive: true });
      appendFileSync(this.historyPath(validated.story_id), JSON.stringify(previous) + "\n", "utf-8");
    }
    writeFileAtomic(this.storyPath(validated.story_id), JSON.stringify(validated, null, 2) + "\n");
    return validated;
  }

  history(storyId: string): Story[] {
    const path = this.historyPath(storyId);
    if (!existsSync(path)) return [];
    return readJsonl(path).map((raw) => StorySchema.parse(raw));
  }

  setStatus(storyId: string, status: StoryStatus, now = new Date().toISOString()): Story {
    const story = this.get(storyId);
    if (!story) throw new Error(`No story "${storyId}" in ledger ${this.dir}`);
    return this.put({ ...story, status, updated_at: now });
  }

  /**
   * Record an explicit `generate` run against the ledger: create the story on
   * first sight, otherwise merge the session in and bump the story version
   * when its content changed. Artifacts keep the latest entry per mode; the
   * superseded story (with its older artifact list) goes to history.
   */
  recordGeneration(
    session: SessionSummary,
    writes: Array<{ output: TranslatorOutput; location: string }>,
    now = new Date().toISOString()
  ): Story {
    const storyId = session.story_id ?? session.session_id;
    const existing = this.get(storyId);
    const evidence = session.summary.evidence ?? [];
    if (evidence.length) this.putEvidence(evidence);

    const fresh: StoryArtifact[] = writes.map(({ output, location }) => ({
      mode: output.mode,
      file: isUrl(location) ? location : basename(location),
      version: output.artifact_version ?? 1,
      prompt_version: output.prompt_version,
      written_at: output.timestamp,
    }));
    const freshModes = new Set(fresh.map((a) => a.mode));

    if (!existing) {
      return this.put({
        story_id: storyId,
        title: session.summary.one_liner,
        status: "approved",
        version: 1,
        created_at: now,
        updated_at: now,
        origin: "generate",
        source_tool: session.source_tool,
        session_ids: [session.session_id],
        observation_ids: [],
        evidence_ids: evidence.map((e) => e.id),
        summary: session.summary,
        artifacts: fresh,
      });
    }

    const changed = contentHash(existing.summary) !== contentHash(session.summary);
    return this.put({
      ...existing,
      title: session.summary.one_liner,
      // An explicit generate is the user approving the story.
      status: "approved",
      version: changed ? existing.version + 1 : existing.version,
      updated_at: now,
      source_tool: session.source_tool,
      session_ids: union(existing.session_ids, [session.session_id]),
      evidence_ids: union(existing.evidence_ids, evidence.map((e) => e.id)),
      summary: session.summary,
      artifacts: [...existing.artifacts.filter((a) => !freshModes.has(a.mode)), ...fresh],
    });
  }

  // ── observations ────────────────────────────────────────────────────────

  private observationsPath(sessionId: string): string {
    return join(this.dir, "observations", `${safeFileStem(sessionId)}.jsonl`);
  }

  appendObservations(observations: Observation[]): void {
    for (const raw of observations) {
      const obs = ObservationSchema.parse(raw);
      const path = this.observationsPath(obs.session_id);
      mkdirSync(join(this.dir, "observations"), { recursive: true });
      appendFileSync(path, JSON.stringify(obs) + "\n", "utf-8");
    }
  }

  listObservations(sessionId?: string): Observation[] {
    const dir = join(this.dir, "observations");
    if (!existsSync(dir)) return [];
    const files = sessionId
      ? [this.observationsPath(sessionId)].filter(existsSync)
      : readdirSync(dir).filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n));
    return files.flatMap((f) => readJsonl(f).map((raw) => ObservationSchema.parse(raw)));
  }

  // ── evidence ────────────────────────────────────────────────────────────

  private evidencePath(): string {
    return join(this.dir, "evidence.jsonl");
  }

  putEvidence(items: Evidence[]): void {
    if (items.length === 0) return;
    mkdirSync(this.dir, { recursive: true });
    const lines = items.map((e) => JSON.stringify(EvidenceSchema.parse(e))).join("\n") + "\n";
    appendFileSync(this.evidencePath(), lines, "utf-8");
  }

  /** Evidence by id (all when `ids` is omitted). Later writes of an id win. */
  getEvidence(ids?: string[]): Evidence[] {
    const path = this.evidencePath();
    if (!existsSync(path)) return [];
    const byId = new Map<string, Evidence>();
    for (const raw of readJsonl(path)) {
      const ev = EvidenceSchema.safeParse(raw);
      if (ev.success) byId.set(ev.data.id, ev.data);
    }
    if (!ids) return [...byId.values()];
    return ids.map((id) => byId.get(id)).filter((e): e is Evidence => e !== undefined);
  }
}

function readJsonl(path: string): unknown[] {
  const out: unknown[] = [];
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip a torn trailing line (crash mid-append); keep the rest.
    }
  }
  return out;
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function isUrl(location: string): boolean {
  return /^https?:\/\//.test(location);
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}
