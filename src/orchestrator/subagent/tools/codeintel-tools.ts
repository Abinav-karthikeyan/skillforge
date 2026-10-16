import { readFileSync, statSync } from "fs";
import { relative, resolve, sep } from "path";
import { z } from "zod";
import { ToolDef } from "./types.js";
import { EntityExtractor } from "../../../codeintel/entities.js";
import { buildStructuralDigest, renderDigest } from "../../../codeintel/digest.js";
import { languageForPath } from "../../../codeintel/languages.js";
import { buildRepoGraph, rankFiles, renderRepoMap, RepoGraph } from "../../../codeintel/repo-map.js";
import { loadCodeIntelRuntime } from "../../../codeintel/runtime.js";
import { trackedFiles } from "../../../codeintel/git.js";
import { isIgnoredPath } from "../../../codeintel/paths.js";
import { Definition } from "../../../codeintel/types.js";

/**
 * Code-intelligence tools for the scout (plan_v3 §2.3). Same sandbox rules
 * as ./registry.ts: every path is resolved against `root` and rejected if it
 * escapes, and every result is size-capped. With the codeintel companion the
 * tools answer from ASTs (L1); without it they fall back to lexical scans
 * (L0) and say so. Reference results are always marked approximate — only an
 * LSP (L2, host-provided) gives precise references.
 */
const MAX_OUTPUT = 8_000;

function cap(text: string): string {
  return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + `\n(…truncated at ${MAX_OUTPUT} chars)` : text;
}

function sandboxPath(root: string, requested: string): string {
  const full = resolve(root, requested);
  const rel = relative(root, full);
  if (rel.startsWith("..") || resolve(rel) === resolve("..")) throw new Error(`path "${requested}" escapes sandbox root`);
  return full;
}

const toPosix = (p: string) => p.split(sep).join("/");

function describe(d: Definition): string {
  const tags = [d.exported ? "exported" : null, d.kind === "function" || d.kind === "method" ? `cc ${d.complexity}` : null]
    .filter(Boolean)
    .join(", ");
  return `L${d.start_line}-${d.end_line} ${d.kind} ${d.qualified}${tags ? ` [${tags}]` : ""} — ${d.signature}`;
}

// Lexical (L0) definition pattern for the starter languages.
const L0_DEF =
  /^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:public\s+|private\s+|protected\s+|internal\s+)?(?:static\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|def|func|fn|struct|trait|impl|record)\s+([A-Za-z_$][\w$]*)/;

export function buildCodeIntelTools(root: string = process.cwd()): ToolDef[] {
  let extractor: Promise<EntityExtractor | null> | undefined;
  const getExtractor = () =>
    (extractor ??= loadCodeIntelRuntime().then((rt) => (rt ? new EntityExtractor(rt) : null)));

  let graph: Promise<RepoGraph | null> | undefined;
  const getGraph = () =>
    (graph ??= getExtractor().then((ex) => (ex ? buildRepoGraph(root, ex) : null)));

  const codeFiles = () => trackedFiles(root).filter((p) => languageForPath(p) && !isIgnoredPath(p)).slice(0, 4_000);
  const readSmall = (path: string): string | null => {
    try {
      const full = sandboxPath(root, path);
      if (statSync(full).size > 512 * 1024) return null;
      return readFileSync(full, "utf-8");
    } catch {
      return null;
    }
  };
  const wordRe = (name: string) => new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, "\\$")}([^\\w$]|$)`);

  const outlineInput = z.object({ path: z.string().min(1) });
  const outline: ToolDef = {
    name: "outline",
    description:
      "List the definitions in one file (functions, methods, classes, interfaces, types) with line ranges, " +
      "export status, cyclomatic complexity, and signatures.",
    input_schema: outlineInput,
    handler: async (raw) => {
      const { path } = outlineInput.parse(raw);
      const source = readSmall(path);
      if (source === null) return `error: cannot read "${path}"`;
      const spec = languageForPath(path);
      const ex = await getExtractor();
      if (ex && spec) {
        const entities = await ex.extract(source, spec);
        if (entities) {
          if (entities.definitions.length === 0) return "no definitions found";
          return cap(entities.definitions.map(describe).join("\n"));
        }
      }
      const lines = source.split(/\r?\n/);
      const hits = lines.flatMap((l, i) => (L0_DEF.test(l) ? [`L${i + 1} ${l.trim().slice(0, 160)}`] : []));
      return cap(`(L0 lexical outline — install the codeintel companion for structure)\n${hits.join("\n") || "no definitions found"}`);
    },
  };

  const findInput = z.object({ name: z.string().min(1) });
  const findSymbol: ToolDef = {
    name: "find_symbol",
    description: "Find where a symbol is defined across the repo (by simple or qualified name, e.g. 'allow' or 'RateLimiter.allow').",
    input_schema: findInput,
    handler: async (raw) => {
      const { name } = findInput.parse(raw);
      const g = await getGraph();
      if (g) {
        const hits = g.files.flatMap((f) =>
          f.definitions
            .filter((d) => d.name === name || d.qualified === name || d.qualified.endsWith(`.${name}`))
            .map((d) => `${f.path}:${describe(d)}`)
        );
        return cap(hits.join("\n") || "no definitions found");
      }
      const leaf = name.split(".").pop()!;
      const hits: string[] = [];
      for (const path of codeFiles()) {
        const text = readSmall(path);
        if (!text) continue;
        text.split(/\r?\n/).forEach((l, i) => {
          const m = L0_DEF.exec(l);
          if (m && m[2] === leaf) hits.push(`${path}:${i + 1}: ${l.trim().slice(0, 160)}`);
        });
        if (hits.length >= 50) break;
      }
      return cap(`(L0 lexical search)\n${hits.join("\n") || "no definitions found"}`);
    },
  };

  const refsInput = z.object({ symbol: z.string().min(1), max_results: z.number().int().min(1).max(100).default(40) });
  const references: ToolDef = {
    name: "references",
    description:
      "Find files and lines that reference a symbol by name. Results are approximate (name-based, no type " +
      "resolution) — report counts as '~N'.",
    input_schema: refsInput,
    handler: async (raw) => {
      const { symbol, max_results } = refsInput.parse(raw);
      const parts = symbol.split(".");
      const leaf = parts.pop()!;
      const container = parts.pop();
      const leafRe = wordRe(leaf);
      const containerRe = container ? wordRe(container) : null;
      const g = await getGraph();
      const candidates = g ? g.files.filter((f) => f.references.has(leaf)).map((f) => f.path) : codeFiles();
      const lines: string[] = [];
      let files = 0;
      for (const path of candidates) {
        const text = readSmall(path);
        if (!text || (containerRe && !containerRe.test(text))) continue;
        let fileHit = false;
        text.split(/\r?\n/).forEach((l, i) => {
          if (leafRe.test(l) && !L0_DEF.test(l)) {
            fileHit = true;
            if (lines.length < max_results) lines.push(`${path}:${i + 1}: ${l.trim().slice(0, 140)}`);
          }
        });
        if (fileHit) files++;
      }
      const header = `approximate: true — ~${files} file(s) reference "${symbol}" by name${g ? "" : " (L0 lexical)"}`;
      return cap([header, ...lines].join("\n"));
    },
  };

  const diffInput = z.object({ rev_range: z.string().default("HEAD~1..HEAD") });
  const structuralDiff: ToolDef = {
    name: "structural_diff",
    description:
      "Entity-level diff for a git range (e.g. 'HEAD~3..HEAD'): which functions/classes/types were added, " +
      "modified, renamed, moved, or removed, with complexity before→after and a change classification.",
    input_schema: diffInput,
    handler: async (raw) => {
      const { rev_range } = diffInput.parse(raw);
      if (/[\s;&|`$]/.test(rev_range)) return "error: invalid rev_range";
      try {
        const digest = await buildStructuralDigest({ root, range: rev_range, scanRepo: false });
        return cap(renderDigest(digest, MAX_OUTPUT - 200));
      } catch (err) {
        return `error: ${(err as Error).message.split("\n")[0]}`;
      }
    },
  };

  const metricsInput = z.object({ target: z.string().min(1) });
  const metrics: ToolDef = {
    name: "metrics",
    description:
      "Cyclomatic complexity for a file path (every function/method, highest first) or for a symbol name " +
      "(every definition with that name).",
    input_schema: metricsInput,
    handler: async (raw) => {
      const { target } = metricsInput.parse(raw);
      const ex = await getExtractor();
      if (!ex) return "error: complexity metrics need the codeintel companion (L1); not installed";
      const fns = (defs: Definition[]) => defs.filter((d) => d.kind === "function" || d.kind === "method");
      const spec = languageForPath(target);
      if (spec) {
        const source = readSmall(target);
        if (source === null) return `error: cannot read "${target}"`;
        const entities = await ex.extract(source, spec);
        if (!entities) return "error: grammar unavailable";
        const list = fns(entities.definitions).sort((a, b) => b.complexity - a.complexity);
        const total = list.reduce((n, d) => n + d.complexity, 0);
        return cap([`${list.length} functions, total cyclomatic complexity ${total}`, ...list.map((d) => `cc ${d.complexity}  ${d.qualified} (L${d.start_line})`)].join("\n"));
      }
      const g = await getGraph();
      const hits = (g?.files ?? []).flatMap((f) =>
        fns(f.definitions)
          .filter((d) => d.name === target || d.qualified === target)
          .map((d) => `cc ${d.complexity}  ${d.qualified} — ${f.path}:${d.start_line}`)
      );
      return cap(hits.join("\n") || "no matching functions");
    },
  };

  const mapInput = z.object({
    budget_tokens: z.number().int().min(100).max(4_000).default(1_000),
    focus: z.array(z.string()).default([]),
  });
  const repoMap: ToolDef = {
    name: "repo_map",
    description:
      "A ranked map of the repository's most central files and their key signatures, fit to a token budget. " +
      "Pass `focus` paths (e.g. the files a change touched) to personalize the ranking toward them.",
    input_schema: mapInput,
    handler: async (raw) => {
      const { budget_tokens, focus } = mapInput.parse(raw);
      const g = await getGraph();
      if (!g) return "error: repo map needs the codeintel companion (L1); not installed";
      const focusPaths = focus.map((p) => toPosix(relative(root, sandboxPath(root, p))));
      return renderRepoMap(g, rankFiles(g, focusPaths), budget_tokens);
    },
  };

  return [outline, findSymbol, references, structuralDiff, metrics, repoMap];
}
