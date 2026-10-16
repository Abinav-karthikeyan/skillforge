import { appendFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { parse, stringify } from "yaml";
import { writeFileAtomic } from "../util/fs.js";

/**
 * `index.yml` — the artifacts directory's catalog. A flat YAML sequence, one
 * entry per artifact file. Story-less writes append (the v1 behaviour); writes
 * that carry a `story_id` upsert by (story_id, mode) so a living artifact keeps
 * one entry whose `version` climbs.
 */
export interface IndexEntry {
  session_id: string;
  mode: string;
  timestamp: string;
  file: string;
  one_liner: string;
  story_id?: string;
  version?: number;
}

export const INDEX_FILENAME = "index.yml";

export function indexPath(artifactsDir: string): string {
  return join(artifactsDir, INDEX_FILENAME);
}

/** Read the index. A missing file is an empty index; a corrupt one throws. */
export function readIndex(artifactsDir: string): IndexEntry[] {
  const path = indexPath(artifactsDir);
  if (!existsSync(path)) return [];
  const parsed = parse(readFileSync(path, "utf-8")) as IndexEntry[] | null;
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    throw new Error(`Artifacts index at ${path} is not a YAML sequence.`);
  }
  return parsed;
}

/**
 * Append one entry. Serialized via the YAML library rather than hand-built: a
 * one_liner containing a quote, colon, or newline would otherwise corrupt the
 * index. Each entry is a single-element sequence (`- key: …`), so appended
 * blocks concatenate into one valid YAML sequence.
 */
export function appendIndexEntry(artifactsDir: string, entry: IndexEntry): void {
  appendFileSync(indexPath(artifactsDir), stringify([entry]), "utf-8");
}

/** Rewrite the whole index atomically (used by the story upsert path). */
export function writeIndex(artifactsDir: string, entries: IndexEntry[]): void {
  writeFileAtomic(indexPath(artifactsDir), entries.length ? stringify(entries) : "");
}
