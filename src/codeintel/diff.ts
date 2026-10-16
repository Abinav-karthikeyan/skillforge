import { EntityChange } from "../types/code-facts.js";
import { Definition, FileEntities } from "./types.js";

/**
 * Entity-level structural diff between two revisions of one file.
 *
 * Matching runs in three passes:
 *   1. same qualified name + kind (nth occurrence, so overloads pair up in order)
 *      → modified when the masked body hash differs, unchanged otherwise
 *   2. identical masked body hash, same kind → pure rename
 *   3. token-set Jaccard ≥ RENAME_SIMILARITY, same kind → rename with edits
 * Whatever is left is added or removed. Cross-file moves are detected by the
 * caller (./digest.ts) from the leftovers of all files.
 */
export const RENAME_SIMILARITY = 0.75;

function occurrenceKeys(defs: Definition[]): Map<string, Definition> {
  const seen = new Map<string, number>();
  const out = new Map<string, Definition>();
  for (const d of defs) {
    const base = `${d.kind}:${d.qualified}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.set(`${base}#${n}`, d);
  }
  return out;
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

const complexityOf = (d: Definition | undefined): number | undefined =>
  d && (d.kind === "function" || d.kind === "method") ? d.complexity : undefined;

export interface FileDiff {
  changes: EntityChange[];
  /** Unpaired removals/additions, kept for cross-file move detection. */
  removed: Definition[];
  added: Definition[];
}

export function diffFileEntities(
  path: string,
  before: FileEntities | null,
  after: FileEntities | null,
  previousPath: string = path
): FileDiff {
  const oldDefs = occurrenceKeys(before?.definitions ?? []);
  const newDefs = occurrenceKeys(after?.definitions ?? []);
  const changes: EntityChange[] = [];

  // Pass 1 — same name.
  for (const [key, next] of newDefs) {
    const prev = oldDefs.get(key);
    if (!prev) continue;
    oldDefs.delete(key);
    newDefs.delete(key);
    if (prev.body_hash === next.body_hash && previousPath === path) continue;
    if (prev.body_hash === next.body_hash) {
      changes.push({
        path,
        symbol: next.qualified,
        kind: next.kind,
        change: "moved",
        previous_path: previousPath,
        exported: next.exported,
      });
      continue;
    }
    changes.push({
      path,
      symbol: next.qualified,
      kind: next.kind,
      change: "modified",
      exported: next.exported || prev.exported,
      signature_changed: prev.signature !== next.signature,
      complexity_before: complexityOf(prev),
      complexity_after: complexityOf(next),
    });
  }

  // Passes 2 and 3 — renames.
  const removed = [...oldDefs.values()];
  const added = [...newDefs.values()];
  const pairRenames = (match: (a: Definition, b: Definition) => boolean) => {
    for (let i = removed.length - 1; i >= 0; i--) {
      const prev = removed[i];
      const j = added.findIndex((next) => next.kind === prev.kind && match(prev, next));
      if (j === -1) continue;
      const next = added[j];
      removed.splice(i, 1);
      added.splice(j, 1);
      changes.push({
        path,
        symbol: next.qualified,
        kind: next.kind,
        change: "renamed",
        previous_symbol: prev.qualified,
        previous_path: previousPath !== path ? previousPath : undefined,
        exported: next.exported || prev.exported,
        signature_changed: prev.signature.replace(prev.name, "") !== next.signature.replace(next.name, ""),
        complexity_before: complexityOf(prev),
        complexity_after: complexityOf(next),
      });
    }
  };
  pairRenames((a, b) => a.body_hash === b.body_hash);
  pairRenames((a, b) => jaccard(a.tokens, b.tokens) >= RENAME_SIMILARITY);

  for (const d of added) {
    changes.push({
      path,
      symbol: d.qualified,
      kind: d.kind,
      change: "added",
      exported: d.exported,
      complexity_after: complexityOf(d),
    });
  }
  for (const d of removed) {
    changes.push({
      path,
      symbol: d.qualified,
      kind: d.kind,
      change: "removed",
      exported: d.exported,
      complexity_before: complexityOf(d),
    });
  }
  return { changes, removed, added };
}
