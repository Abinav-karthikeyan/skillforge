import { readFileSync, statSync } from "fs";
import { join } from "path";
import { CodeFacts, EntityChange } from "../types/code-facts.js";
import { classifyChange } from "./classify.js";
import { diffFileEntities } from "./diff.js";
import { EntityExtractor } from "./entities.js";
import { buildFingerprint } from "./fingerprint.js";
import {
  ChangedFile,
  changedFiles,
  commitSubjects,
  fileAt,
  EMPTY_TREE,
  generatedOrVendored,
  git,
  hunkSymbols,
  resolveRange,
  ResolvedRange,
  trackedFiles,
} from "./git.js";
import { languageForPath, languageLabel } from "./languages.js";
import { AgentTraceRecord, attributionFor, loadAgentTraces } from "./attribution.js";
import { isIgnoredPath, isLockfile, isTestPath } from "./paths.js";
import { GENERIC_NAMES } from "./repo-map.js";
import { loadCodeIntelRuntime } from "./runtime.js";
import { CodeIntelRuntime, Definition } from "./types.js";

/**
 * The structural digest replaces v2's "first 15 KB of the raw diff" in the
 * ingestor: a complete, compact account of what changed, computed without an
 * LLM. With the codeintel companion it is entity-level (L1); without it, it is
 * file-level with hunk-header symbols (L0). Either way nothing is cut off
 * mid-change — detail is summarized, never truncated.
 */
export interface DigestFile extends ChangedFile {
  language: string | null;
  /** Entity changes in this file (L1 only). */
  changes: EntityChange[];
  /** True when the file was parsed at both revisions. */
  analyzed: boolean;
}

export interface StructuralDigest {
  range: ResolvedRange;
  layer: "L0" | "L1";
  files: DigestFile[];
  /** Generated, vendored, build output, and lockfiles — excluded from every metric. */
  skipped: string[];
  subjects: string[];
  facts: CodeFacts;
}

export interface DigestOptions {
  root: string;
  /** `A..B`, `A...B`, a commit, or omitted for HEAD~1..HEAD. */
  range?: string;
  /** Inject a runtime (tests) or `null` to force L0. Omitted: load the companion if installed. */
  runtime?: CodeIntelRuntime | null;
  /** Cap on files parsed for entity diffs; the rest still count in file/line totals. */
  maxAnalyzedFiles?: number;
  /** Scan the working tree for test linkage and blast radius (default true). */
  scanRepo?: boolean;
  /** Agent Trace records to attribute lines from (default: the imported store). */
  traces?: AgentTraceRecord[];
}

/** Max entity changes kept in `facts.entity_changes`; `facts.entities` counts stay complete. */
export const MAX_FACT_CHANGES = 60;

function significance(c: EntityChange): number {
  const delta = Math.abs((c.complexity_after ?? 0) - (c.complexity_before ?? 0));
  return (c.exported ? 3 : 0) + delta + (c.change === "modified" ? 0 : 1) + (c.signature_changed ? 1 : 0);
}

/** Pair leftover removals in one file with identical additions in another → moved. */
function detectMoves(
  leftovers: Array<{ path: string; removed: Definition[]; added: Definition[] }>,
  changes: EntityChange[]
): EntityChange[] {
  const moved: EntityChange[] = [];
  const drop = new Set<string>();
  for (const from of leftovers) {
    for (const r of from.removed) {
      for (const to of leftovers) {
        if (to.path === from.path) continue;
        const i = to.added.findIndex((a) => a.kind === r.kind && a.body_hash === r.body_hash);
        if (i === -1) continue;
        const a = to.added.splice(i, 1)[0];
        drop.add(`${from.path}\0${r.qualified}\0removed`);
        drop.add(`${to.path}\0${a.qualified}\0added`);
        moved.push({
          path: to.path,
          symbol: a.qualified,
          kind: a.kind,
          change: "moved",
          previous_path: from.path,
          previous_symbol: a.qualified !== r.qualified ? r.qualified : undefined,
          exported: a.exported || r.exported,
        });
        break;
      }
    }
  }
  return [...changes.filter((c) => !drop.has(`${c.path}\0${c.symbol}\0${c.change}`)), ...moved];
}

interface RepoScan {
  linked: Array<{ test_file: string; symbols: string[] }>;
  blast: CodeFacts["blast_radius"];
}

/**
 * Name-based scan of the working tree: which test files mention a changed
 * symbol, and how many other files mention each changed public symbol. Both
 * are approximate by construction (L1); precise counts need LSP (L2).
 */
function scanRepo(root: string, tracked: string[], changes: EntityChange[]): RepoScan {
  const parts = (s: string) => s.split(".");
  const leaf = (s: string) => parts(s).pop() ?? s;
  const named = changes.filter((c) => {
    const n = leaf(c.symbol);
    return n.length >= 3 && !GENERIC_NAMES.has(n) && c.change !== "removed";
  });
  const testSymbols = [...new Map(named.map((c) => [c.symbol, c])).values()].slice(0, 50);
  const blastTargets = changes
    .filter((c) => c.exported && c.change !== "added" && leaf(c.symbol).length >= 3)
    .sort((a, b) => significance(b) - significance(a))
    .slice(0, 10);
  if (testSymbols.length === 0 && blastTargets.length === 0) return { linked: [], blast: [] };

  const regex = new Map<string, RegExp>();
  const re = (name: string) => {
    let r = regex.get(name);
    if (!r) regex.set(name, (r = new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, "\\$")}([^\\w$]|$)`)));
    return r;
  };
  // A member `Class.method` only counts where both names appear — a bare
  // `write` or `chat` would match half the repo. Still name-based, so still
  // approximate; precise references need LSP (L2).
  const mentions = (c: EntityChange, text: string) => {
    const [container, ...rest] = parts(c.symbol);
    if (rest.length === 0) return !GENERIC_NAMES.has(container) && re(container).test(text);
    return re(container).test(text) && re(rest[rest.length - 1]).test(text);
  };
  const blastCounts = new Map<EntityChange, number>(blastTargets.map((c) => [c, 0]));
  const linked: RepoScan["linked"] = [];

  const scannable = tracked.filter((p) => languageLabel(p) && !isIgnoredPath(p)).slice(0, 4_000);
  for (const path of scannable) {
    let text: string;
    try {
      const full = join(root, path);
      if (statSync(full).size > 256 * 1024) continue;
      text = readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    if (isTestPath(path)) {
      const hits = testSymbols.filter((c) => c.path !== path && mentions(c, text)).map((c) => c.symbol);
      if (hits.length) linked.push({ test_file: path, symbols: hits });
    }
    for (const c of blastTargets) {
      if (path !== c.path && mentions(c, text)) blastCounts.set(c, blastCounts.get(c)! + 1);
    }
  }
  return {
    linked: linked.slice(0, 30),
    blast: blastTargets.map((c) => ({
      symbol: c.symbol,
      path: c.path,
      referencing_files: blastCounts.get(c)!,
      approximate: true,
    })),
  };
}

export async function buildStructuralDigest(opts: DigestOptions): Promise<StructuralDigest> {
  const { root } = opts;
  const range = resolveRange(root, opts.range);
  const all = changedFiles(root, range);
  const flagged = generatedOrVendored(root, all.map((f) => f.path));
  const skipped = all.filter((f) => flagged.has(f.path) || isIgnoredPath(f.path) || isLockfile(f.path));
  const files = all.filter((f) => !skipped.includes(f));
  const subjects = commitSubjects(root, range);
  const runtime = opts.runtime !== undefined ? opts.runtime : await loadCodeIntelRuntime();
  const extractor = runtime ? new EntityExtractor(runtime) : null;
  const maxAnalyzed = opts.maxAnalyzedFiles ?? 300;

  const digestFiles: DigestFile[] = [];
  let changes: EntityChange[] = [];
  const leftovers: Array<{ path: string; removed: Definition[]; added: Definition[] }> = [];
  let analyzedCount = 0;

  for (const file of files) {
    const spec = languageForPath(file.path);
    const entry: DigestFile = { ...file, language: languageLabel(file.path), changes: [], analyzed: false };
    digestFiles.push(entry);
    if (!extractor || !spec || file.binary || analyzedCount >= maxAnalyzed) continue;

    const beforePath = file.previous_path ?? file.path;
    const beforeSpec = languageForPath(beforePath) ?? spec;
    const beforeSrc = file.status === "added" ? null : fileAt(root, range.base, beforePath);
    const afterSrc = file.status === "deleted" ? null : fileAt(root, range.head, file.path);
    const before = beforeSrc !== null ? await extractor.extract(beforeSrc, beforeSpec) : null;
    const after = afterSrc !== null ? await extractor.extract(afterSrc, spec) : null;
    if ((beforeSrc !== null && !before) || (afterSrc !== null && !after)) continue;

    analyzedCount++;
    entry.analyzed = true;
    const diff = diffFileEntities(file.path, before, after, beforePath);
    entry.changes = diff.changes;
    changes.push(...diff.changes);
    leftovers.push({ path: file.path, removed: diff.removed, added: diff.added });
  }

  if (extractor) {
    changes = detectMoves(leftovers, changes);
    for (const f of digestFiles) f.changes = changes.filter((c) => c.path === f.path);
  }

  const layer = extractor ? "L1" : "L0";
  const count = (kind: EntityChange["change"]) => changes.filter((c) => c.change === kind).length;
  const complexity = extractor
    ? {
        touched_before: changes.reduce((n, c) => n + (c.complexity_before ?? 0), 0),
        touched_after: changes.reduce((n, c) => n + (c.complexity_after ?? 0), 0),
      }
    : undefined;
  const { classification, reasons } = classifyChange({ files, changes, subjects, complexity });

  const tracked = opts.scanRepo === false ? [] : trackedFiles(root, range.head);
  const scan = extractor && opts.scanRepo !== false ? scanRepo(root, tracked, changes) : { linked: [], blast: [] };
  const languages: Record<string, number> = {};
  for (const f of digestFiles) if (f.language) languages[f.language] = (languages[f.language] ?? 0) + 1;

  const ranked = [...changes].sort((a, b) => significance(b) - significance(a));
  const facts: CodeFacts = {
    layer,
    source: extractor ? "ast" : "git",
    range: range.label,
    files_changed: files.length,
    lines_added: files.reduce((n, f) => n + f.lines_added, 0),
    lines_removed: files.reduce((n, f) => n + f.lines_removed, 0),
    languages,
    classification,
    classification_reasons: reasons,
    entities: extractor
      ? { added: count("added"), modified: count("modified"), removed: count("removed"), renamed: count("renamed"), moved: count("moved") }
      : undefined,
    entity_changes: ranked.slice(0, MAX_FACT_CHANGES),
    entity_changes_omitted: ranked.length > MAX_FACT_CHANGES ? ranked.length - MAX_FACT_CHANGES : undefined,
    complexity,
    public_api: changes
      .filter((c) => c.exported)
      .map((c) => ({ path: c.path, symbol: c.symbol, kind: c.kind, change: c.change })),
    tests: {
      test_files_changed: files.filter((f) => isTestPath(f.path)).length,
      linked: scan.linked,
    },
    blast_radius: scan.blast,
    hunk_symbols: extractor ? undefined : hunkSymbols(root, range),
    fingerprint:
      opts.scanRepo === false
        ? undefined
        : buildFingerprint({ root, range, files, tracked, changes }),
  };

  const traces = opts.traces ?? loadAgentTraces();
  if (traces.length) {
    const shas = (range.base === EMPTY_TREE ? [range.head] : git(root, ["rev-list", `${range.base}..${range.head}`], { allowFail: true }).split(/\s+/))
      .filter(Boolean);
    const attribution = attributionFor(traces, shas);
    if (attribution) facts.attribution = { source: "agent-trace", ...attribution };
  }

  return { range, layer, files: digestFiles, skipped: skipped.map((f) => f.path), subjects, facts };
}

// ── rendering ──────────────────────────────────────────────────────────────

const STATUS_CODE: Record<string, string> = {
  added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", "type-changed": "T",
};
const CHANGE_MARK: Record<EntityChange["change"], string> = {
  added: "+", modified: "~", removed: "-", renamed: "↻", moved: "→",
};

function describeChange(c: EntityChange): string {
  const parts = [`${CHANGE_MARK[c.change]} ${c.kind} ${c.symbol}`];
  if (c.change === "renamed" && c.previous_symbol) parts[0] += ` (was ${c.previous_symbol})`;
  if (c.change === "moved" && c.previous_path) parts[0] += ` (from ${c.previous_path})`;
  const tags: string[] = [];
  if (c.exported) tags.push("exported");
  if (c.complexity_before !== undefined && c.complexity_after !== undefined) {
    if (c.complexity_before !== c.complexity_after) tags.push(`cc ${c.complexity_before}→${c.complexity_after}`);
    else tags.push(`cc ${c.complexity_after}`);
  } else if (c.complexity_after !== undefined) {
    tags.push(`cc ${c.complexity_after}`);
  } else if (c.complexity_before !== undefined) {
    tags.push(`cc ${c.complexity_before}`);
  }
  if (c.signature_changed) tags.push("signature changed");
  return tags.length ? `${parts[0]} [${tags.join(", ")}]` : parts[0];
}

/**
 * Compact text for the ingest prompt. Every changed file is always listed;
 * when per-entity detail would exceed `maxChars`, the least significant
 * files collapse to per-kind counts. Nothing is cut mid-change.
 */
export function renderDigest(d: StructuralDigest, maxChars = 12_000): string {
  const f = d.facts;
  const header: string[] = [
    `Structural digest (${d.layer}${d.layer === "L1" ? " · tree-sitter" : " · git only"}) for ${f.range} — complete; every changed file is listed.`,
    `Classification: ${f.classification} (${f.classification_reasons.join("; ")})`,
    `Totals: ${f.files_changed} files changed (+${f.lines_added}/−${f.lines_removed})` +
      (f.entities
        ? `; entities +${f.entities.added} ~${f.entities.modified} −${f.entities.removed} ↻${f.entities.renamed} →${f.entities.moved}`
        : "") +
      (f.complexity ? `; touched cyclomatic complexity ${f.complexity.touched_before} → ${f.complexity.touched_after}` : ""),
  ];

  const fileLine = (file: DigestFile) =>
    `  ${STATUS_CODE[file.status] ?? "M"} ${file.previous_path ? `${file.previous_path} → ` : ""}${file.path}` +
    ` (${file.language ?? "other"}, +${file.lines_added}/−${file.lines_removed})` +
    (isTestPath(file.path) ? " [test]" : "") +
    (file.binary ? " [binary]" : "");

  const detailed = (file: DigestFile) => [fileLine(file), ...file.changes.map((c) => `      ${describeChange(c)}`)];
  const summarized = (file: DigestFile) => {
    if (file.changes.length === 0) return [fileLine(file)];
    const tally = new Map<string, number>();
    for (const c of file.changes) tally.set(c.change, (tally.get(c.change) ?? 0) + 1);
    return [`${fileLine(file)} — ${[...tally].map(([k, v]) => `${v} ${k}`).join(", ")}`];
  };

  // Spend the budget on the most significant files first.
  const order = [...d.files].sort(
    (a, b) => b.changes.reduce((n, c) => n + significance(c), 0) - a.changes.reduce((n, c) => n + significance(c), 0)
  );
  const fixed = header.join("\n").length + d.files.reduce((n, file) => n + fileLine(file).length + 1, 0) + 600;
  let budget = maxChars - fixed;
  const expand = new Set<DigestFile>();
  for (const file of order) {
    const cost = detailed(file).join("\n").length - fileLine(file).length;
    if (file.changes.length && cost <= budget) {
      expand.add(file);
      budget -= cost;
    }
  }

  const lines = [...header, "Files:"];
  for (const file of d.files) lines.push(...(expand.has(file) ? detailed(file) : summarized(file)));
  const collapsed = d.files.filter((file) => file.changes.length && !expand.has(file)).length;
  if (collapsed) lines.push(`  (${collapsed} file(s) shown as per-kind counts to fit the prompt budget)`);

  if (f.public_api.length) {
    const shown = f.public_api.slice(0, 15).map((p) => `${CHANGE_MARK[p.change]}${p.symbol}`);
    lines.push(`Public API: ${shown.join(", ")}${f.public_api.length > 15 ? `, … (${f.public_api.length} total)` : ""}`);
  }
  if (f.tests) {
    const linked = f.tests.linked.slice(0, 8).map((t) => `${t.test_file} → ${t.symbols.slice(0, 4).join(", ")}`);
    lines.push(
      `Tests: ${f.tests.test_files_changed} test file(s) changed` +
        (linked.length ? `; tests referencing changed symbols: ${linked.join("; ")}` : "")
    );
  }
  if (f.blast_radius.length) {
    lines.push(`Blast radius (name-based, approximate): ${f.blast_radius.map((b) => `${b.symbol} ~${b.referencing_files} files`).join(", ")}`);
  }
  if (f.hunk_symbols?.length) lines.push(`Symbols in changed hunks: ${f.hunk_symbols.join(", ")}`);
  if (f.attribution) {
    const a = f.attribution;
    lines.push(
      `Attribution (Agent Trace): ${a.ai_lines} AI-written, ${a.mixed_lines} mixed, ${a.human_lines} human, ${a.unknown_lines} unattributed lines` +
        (a.tools.length ? ` via ${a.tools.join(", ")}` : "")
    );
  }
  if (f.fingerprint) {
    const fp = f.fingerprint;
    const bits = [
      fp.languages.length ? `languages ${fp.languages.join(", ")}` : "",
      fp.frameworks.length ? `frameworks ${fp.frameworks.join(", ")}` : "",
      fp.dependencies_added.length ? `dependencies added ${fp.dependencies_added.join(", ")}` : "",
      fp.patterns.length ? `pattern hints ${fp.patterns.join(", ")}` : "",
    ].filter(Boolean);
    if (bits.length) lines.push(`Fingerprint: ${bits.join("; ")}`);
  }
  if (d.skipped.length) {
    lines.push(`Excluded from metrics (generated/vendored/lockfiles): ${d.skipped.slice(0, 10).join(", ")}${d.skipped.length > 10 ? ", …" : ""}`);
  }
  return lines.join("\n");
}
