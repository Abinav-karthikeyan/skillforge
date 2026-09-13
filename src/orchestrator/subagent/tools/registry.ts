import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve, relative, sep } from "path";
import { execFileSync } from "child_process";
import { z } from "zod";
import { ToolDef } from "./types.js";

// ── Sandbox / safety caps ─────────────────────────────────────────────────
// The scout runs in-process, so tool inputs come from an LLM. Every path is
// resolved against `root` and rejected if it escapes; results are capped so
// a runaway grep can't blow up context. These caps intentionally err small —
// the scout only needs corroborating signal, not exhaustive listings.

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".cache",
  "coverage", ".turbo", ".venv", "__pycache__",
]);

const MAX_WALK_FILES = 5_000;      // hard ceiling on files enumerated per call
const MAX_GREP_MATCHES = 50;
const MAX_LIST_RESULTS = 100;
const MAX_READ_BYTES = 8_192;      // 8 KB per read_file call
const MAX_GIT_LOG_LINES = 50;

function sandboxPath(root: string, requested: string): string {
  const resolved = resolve(root, requested);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || resolve(rel) === resolve("..")) {
    throw new Error(`path "${requested}" escapes sandbox root`);
  }
  return resolved;
}

function* walk(root: string, dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (IGNORED_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      yield* walk(root, full);
    } else if (st.isFile()) {
      yield full;
    }
  }
}

function matchesGlob(relPath: string, glob: string): boolean {
  // Minimal glob: supports `**`, `*`, and literal segments. Sufficient for
  // scout use ("src/**/*.ts", "*.md"); we're not shipping a full matcher.
  //
  // `**/` matches zero or more directory segments, so "src/**/*.ts" matches a
  // file directly in src/ as well as nested ones, and the default "**/*"
  // matches root-level files. `*` stays within a single segment. Placeholders
  // keep the star rewrites from colliding while we substitute.
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex metachars (not * or /)
    .replace(/\*\*\//g, "::GLOBSTAR_SLASH::") // ** + slash → zero or more dirs
    .replace(/\*\*/g, "::GLOBSTAR::") // bare ** → anything, crossing dirs
    .replace(/\*/g, "::STAR::") // * → within one segment
    .replace(/::GLOBSTAR_SLASH::/g, "(?:[^/]+/)*")
    .replace(/::GLOBSTAR::/g, ".*")
    .replace(/::STAR::/g, "[^/]*");
  const normalized = relPath.split(sep).join("/");
  return new RegExp(`^${escaped}$`).test(normalized);
}

// ── Tool implementations ─────────────────────────────────────────────────

function makeGrep(root: string): ToolDef {
  const input = z.object({
    pattern: z.string().min(1),
    glob: z.string().default("**/*"),
    case_insensitive: z.boolean().default(false),
  });
  return {
    name: "grep",
    description:
      "Search file contents for a regex pattern within the repo root. " +
      "Returns up to 50 `path:line: match` results. Use `glob` to scope (e.g. 'src/**/*.ts'). " +
      "Case-sensitive by default; set case_insensitive=true if needed.",
    input_schema: input,
    handler: async (raw) => {
      const { pattern, glob, case_insensitive } = input.parse(raw);
      let re: RegExp;
      try {
        re = new RegExp(pattern, case_insensitive ? "i" : "");
      } catch (err) {
        return `error: invalid regex: ${(err as Error).message}`;
      }
      const results: string[] = [];
      let filesScanned = 0;
      for (const full of walk(root, root)) {
        if (filesScanned++ >= MAX_WALK_FILES) break;
        const rel = relative(root, full);
        if (!matchesGlob(rel, glob)) continue;
        let content: string;
        try {
          content = readFileSync(full, "utf-8");
        } catch { continue; }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            results.push(`${rel.split(sep).join("/")}:${i + 1}: ${lines[i].trim()}`);
            if (results.length >= MAX_GREP_MATCHES) break;
          }
        }
        if (results.length >= MAX_GREP_MATCHES) break;
      }
      if (results.length === 0) return "no matches";
      const capped = results.length >= MAX_GREP_MATCHES ? "\n(truncated at 50)" : "";
      return results.join("\n") + capped;
    },
  };
}

function makeReadFile(root: string): ToolDef {
  const input = z.object({
    path: z.string().min(1),
    offset_bytes: z.number().int().min(0).default(0),
    max_bytes: z.number().int().min(1).max(MAX_READ_BYTES).default(MAX_READ_BYTES),
  });
  return {
    name: "read_file",
    description:
      `Read a bounded slice of a file within the repo root. Caps at ${MAX_READ_BYTES} bytes per call ` +
      "so use `offset_bytes` if you need to page through a large file. Returns raw text.",
    input_schema: input,
    handler: async (raw) => {
      const { path, offset_bytes, max_bytes } = input.parse(raw);
      const full = sandboxPath(root, path);
      let buf: Buffer;
      try {
        buf = readFileSync(full);
      } catch (err) {
        return `error: ${(err as Error).message}`;
      }
      const slice = buf.subarray(offset_bytes, offset_bytes + max_bytes).toString("utf-8");
      const suffix = buf.length > offset_bytes + max_bytes ? `\n(…${buf.length - offset_bytes - max_bytes} more bytes)` : "";
      return slice + suffix;
    },
  };
}

function makeListFiles(root: string): ToolDef {
  const input = z.object({
    glob: z.string().min(1),
  });
  return {
    name: "list_files",
    description:
      "List files under the repo root matching a glob (e.g. 'src/**/*.ts'). Returns up to 100 paths.",
    input_schema: input,
    handler: async (raw) => {
      const { glob } = input.parse(raw);
      const results: string[] = [];
      let filesScanned = 0;
      for (const full of walk(root, root)) {
        if (filesScanned++ >= MAX_WALK_FILES) break;
        const rel = relative(root, full).split(sep).join("/");
        if (matchesGlob(rel, glob)) {
          results.push(rel);
          if (results.length >= MAX_LIST_RESULTS) break;
        }
      }
      if (results.length === 0) return "no matches";
      const capped = results.length >= MAX_LIST_RESULTS ? "\n(truncated at 100)" : "";
      return results.join("\n") + capped;
    },
  };
}

function makeGitLog(root: string): ToolDef {
  const input = z.object({
    limit: z.number().int().min(1).max(MAX_GIT_LOG_LINES).default(20),
  });
  return {
    name: "git_log",
    description:
      "Return the most recent git commits (short SHA + subject) from the repo. " +
      "Useful for grounding focus signals in recent activity.",
    input_schema: input,
    handler: async (raw) => {
      const { limit } = input.parse(raw);
      try {
        const out = execFileSync(
          "git",
          ["log", "--oneline", `-n`, String(limit)],
          { cwd: root, encoding: "utf-8", timeout: 5_000 }
        );
        return out.trim() || "(no commits)";
      } catch (err) {
        return `error: ${(err as Error).message}`;
      }
    },
  };
}

/**
 * Build the full tool set the scout can be granted. The caller (conductor)
 * decides which subset to hand to the runtime based on the effort tier —
 * `max_tool_calls` bounds usage; passing an empty tool array disables the
 * tool loop entirely.
 */
export function buildScoutTools(root: string = process.cwd()): ToolDef[] {
  return [
    makeGrep(root),
    makeReadFile(root),
    makeListFiles(root),
    makeGitLog(root),
  ];
}
