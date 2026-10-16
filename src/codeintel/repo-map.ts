import { readFileSync, statSync } from "fs";
import { join } from "path";
import { EntityExtractor } from "./entities.js";
import { trackedFiles } from "./git.js";
import { languageForPath } from "./languages.js";
import { isIgnoredPath } from "./paths.js";
import { Definition } from "./types.js";

/**
 * Aider-style repository map: parse files, connect each file to the files
 * that define the names it references, rank files with PageRank personalized
 * toward the files a change touched, and emit the top signatures within a
 * token budget (~4 chars/token). Gives the scout and the deep-dive cheap
 * architectural context without an index or embeddings.
 */
export interface RepoFile {
  path: string;
  definitions: Definition[];
  references: Map<string, number>;
}

export interface RepoGraph {
  files: RepoFile[];
  /** Simple name → files defining it. */
  definers: Map<string, string[]>;
  /** Supported files that were skipped by the size or count caps. */
  skipped: number;
}

/** Names too generic to link files meaningfully. */
export const GENERIC_NAMES = new Set([
  "get", "set", "run", "main", "init", "new", "test", "call", "apply", "bind", "next", "then",
  "push", "pop", "map", "filter", "reduce", "find", "join", "split", "parse", "toString",
  "constructor", "length", "value", "data", "error", "log", "handle", "handler", "index",
  "String", "Error", "Object", "Array", "Promise", "Map", "Set", "Date", "JSON", "Math",
  "self", "this", "super", "len", "print", "str", "int", "dict", "list", "fmt", "Println",
]);

export interface RepoGraphOptions {
  files?: string[];
  maxFiles?: number;
  maxBytes?: number;
}

export async function buildRepoGraph(
  root: string,
  extractor: EntityExtractor,
  opts: RepoGraphOptions = {}
): Promise<RepoGraph> {
  const maxFiles = opts.maxFiles ?? 1_500;
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const candidates = (opts.files ?? trackedFiles(root)).filter((p) => languageForPath(p) && !isIgnoredPath(p));

  const files: RepoFile[] = [];
  let skipped = Math.max(0, candidates.length - maxFiles);
  for (const path of candidates.slice(0, maxFiles)) {
    const full = join(root, path);
    let source: string;
    try {
      if (statSync(full).size > maxBytes) {
        skipped++;
        continue;
      }
      source = readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    const entities = await extractor.extract(source, languageForPath(path)!);
    if (!entities) continue;
    const references = new Map<string, number>();
    for (const r of entities.references) references.set(r, (references.get(r) ?? 0) + 1);
    files.push({ path, definitions: entities.definitions, references });
  }

  const definers = new Map<string, string[]>();
  for (const f of files) {
    for (const d of f.definitions) {
      if (d.name.length < 3 || GENERIC_NAMES.has(d.name)) continue;
      const list = definers.get(d.name) ?? [];
      if (!list.includes(f.path)) list.push(f.path);
      definers.set(d.name, list);
    }
  }
  return { files, definers, skipped };
}

/** Personalized PageRank over file → defining-file reference edges. */
export function rankFiles(
  graph: RepoGraph,
  personalize: string[] = [],
  iterations = 40,
  damping = 0.85
): Map<string, number> {
  const paths = graph.files.map((f) => f.path);
  const index = new Map(paths.map((p, i) => [p, i]));
  const n = paths.length;
  const ranks = new Map<string, number>();
  if (n === 0) return ranks;

  const out: Array<Map<number, number>> = paths.map(() => new Map());
  graph.files.forEach((f, i) => {
    for (const [name, count] of f.references) {
      const targets = (graph.definers.get(name) ?? []).filter((p) => p !== f.path);
      if (targets.length === 0) continue;
      // sqrt dampens files that call one helper a hundred times.
      const w = Math.sqrt(count) / targets.length;
      for (const t of targets) {
        const j = index.get(t)!;
        out[i].set(j, (out[i].get(j) ?? 0) + w);
      }
    }
  });
  const outWeight = out.map((m) => [...m.values()].reduce((a, b) => a + b, 0));

  const focus = personalize.map((p) => index.get(p)).filter((i): i is number => i !== undefined);
  const p = new Array<number>(n).fill(focus.length ? 0 : 1 / n);
  for (const i of focus) p[i] = 1 / focus.length;

  let rank = [...p];
  for (let iter = 0; iter < iterations; iter++) {
    const next = p.map((pi) => (1 - damping) * pi);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (outWeight[i] === 0) {
        dangling += rank[i];
        continue;
      }
      for (const [j, w] of out[i]) next[j] += (damping * rank[i] * w) / outWeight[i];
    }
    for (let i = 0; i < n; i++) next[i] += damping * dangling * p[i];
    rank = next;
  }
  paths.forEach((path, i) => ranks.set(path, rank[i]));
  return ranks;
}

const KIND_ORDER: Record<string, number> = {
  class: 0, interface: 1, struct: 1, trait: 1, type: 2, enum: 2, function: 3, method: 4, module: 5,
};

/** Render the top-ranked files' signatures within `budgetTokens` (~4 chars/token). */
export function renderRepoMap(graph: RepoGraph, ranks: Map<string, number>, budgetTokens = 1_000): string {
  const budgetChars = budgetTokens * 4;
  const ordered = [...graph.files].sort((a, b) => (ranks.get(b.path) ?? 0) - (ranks.get(a.path) ?? 0));
  const blocks: string[] = [];
  let used = 0;
  for (const file of ordered) {
    const defs = [...file.definitions]
      .sort(
        (a, b) =>
          Number(b.exported) - Number(a.exported) ||
          (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) ||
          a.start_line - b.start_line
      )
      .slice(0, 8);
    if (defs.length === 0) continue;
    const block = [`${file.path}:`, ...defs.map((d) => `  ${d.signature}`)].join("\n");
    if (used + block.length + 1 > budgetChars) {
      if (blocks.length === 0) blocks.push(block.slice(0, budgetChars));
      break;
    }
    blocks.push(block);
    used += block.length + 1;
  }
  const footer = `(${blocks.length} of ${graph.files.length} parsed files shown` +
    (graph.skipped ? `; ${graph.skipped} skipped by size/count caps` : "") + ")";
  return [...blocks, footer].join("\n");
}
