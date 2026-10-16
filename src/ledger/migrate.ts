import { IndexEntry, readIndex } from "../output/index-file.js";
import { Story } from "../types/ledger.js";
import { StoryLedger } from "./store.js";

/**
 * Legacy → ledger migration (plan_v3 §5). Every artifact written before the
 * ledger existed is an `index.yml` entry with no story. Grouping entries by
 * `story_id ?? session_id` turns each generate run into a story with one
 * version — the same read-fallback spirit as the `LEGACY_*` constants in
 * src/config/paths.ts.
 */
export function storiesFromIndex(entries: IndexEntry[]): Story[] {
  const groups = new Map<string, IndexEntry[]>();
  for (const entry of entries) {
    const key = entry.story_id ?? entry.session_id;
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  const stories: Story[] = [];
  for (const [storyId, group] of groups) {
    const sorted = [...group].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    // Keep the latest entry per mode, as the ledger does.
    const latestByMode = new Map<string, IndexEntry>();
    for (const entry of sorted) latestByMode.set(entry.mode, entry);

    stories.push({
      story_id: storyId,
      title: last.one_liner,
      // These artifacts were generated on explicit user request.
      status: "approved",
      version: Math.max(1, ...group.map((e) => e.version ?? 1)),
      created_at: String(first.timestamp),
      updated_at: String(last.timestamp),
      origin: "legacy-index",
      source_tool: "claude-code",
      session_ids: [...new Set(sorted.map((e) => e.session_id).filter(Boolean))],
      observation_ids: [],
      evidence_ids: [],
      artifacts: [...latestByMode.values()].map((e) => ({
        mode: e.mode,
        file: e.file,
        version: e.version ?? 1,
        written_at: String(e.timestamp),
      })),
    });
  }
  return stories;
}

/**
 * Every story visible for an artifacts directory: ledger stories win, and any
 * `index.yml` group the ledger has not seen yet loads as a legacy story.
 */
export function loadAllStories(artifactsDir: string, ledger: StoryLedger): Story[] {
  const persisted = ledger.list();
  const known = new Set(persisted.map((s) => s.story_id));
  const legacy = storiesFromIndex(readIndex(artifactsDir)).filter((s) => !known.has(s.story_id));
  return [...persisted, ...legacy].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
}

/** Persist the legacy stories into the ledger. Idempotent. */
export function migrateIndexToLedger(
  artifactsDir: string,
  ledger: StoryLedger
): { created: number; skipped: number } {
  let created = 0;
  let skipped = 0;
  for (const story of storiesFromIndex(readIndex(artifactsDir))) {
    if (ledger.get(story.story_id)) {
      skipped++;
      continue;
    }
    ledger.put(story);
    created++;
  }
  return { created, skipped };
}
