import { execFileSync } from "child_process";

/** git's well-known empty tree — the base for a repository's first commit. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const MAX_BUFFER = 64 * 1024 * 1024;

export function git(root: string, args: string[], opts: { input?: string; allowFail?: boolean } = {}): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf-8",
      input: opts.input,
      maxBuffer: MAX_BUFFER,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (err) {
    if (opts.allowFail) return "";
    throw err;
  }
}

export function isGitRepo(root: string): boolean {
  return git(root, ["rev-parse", "--is-inside-work-tree"], { allowFail: true }).trim() === "true";
}

export interface ResolvedRange {
  /** Commit-ish of the "before" side (EMPTY_TREE for a root commit). */
  base: string;
  head: string;
  /** Human-readable range, e.g. `a1b2c3d..e4f5a6b`. */
  label: string;
}

/**
 * Resolve `A..B`, `A...B` (merge-base), a single commit (its parent → it), or
 * nothing (HEAD~1..HEAD). A root commit diffs against the empty tree.
 */
export function resolveRange(root: string, range?: string): ResolvedRange {
  let baseSpec: string | undefined;
  let headSpec = "HEAD";
  if (range && range.includes("...")) {
    const [a, b] = range.split("...");
    headSpec = b || "HEAD";
    baseSpec = git(root, ["merge-base", a, headSpec]).trim();
  } else if (range && range.includes("..")) {
    const [a, b] = range.split("..");
    baseSpec = a;
    headSpec = b || "HEAD";
  } else if (range) {
    headSpec = range;
  }

  const head = git(root, ["rev-parse", "--verify", `${headSpec}^{commit}`]).trim();
  let base: string;
  if (baseSpec) {
    base = git(root, ["rev-parse", "--verify", `${baseSpec}^{commit}`]).trim();
  } else {
    base = git(root, ["rev-parse", "--verify", "--quiet", `${head}~1^{commit}`], { allowFail: true }).trim() || EMPTY_TREE;
  }
  const short = (sha: string) => (sha === EMPTY_TREE ? "(root)" : sha.slice(0, 7));
  return { base, head, label: `${short(base)}..${short(head)}` };
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed";

export interface ChangedFile {
  path: string;
  previous_path?: string;
  status: FileStatus;
  lines_added: number;
  lines_removed: number;
  binary: boolean;
}

const STATUS: Record<string, FileStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
};

/** Files changed in the range, with rename detection and line counts. */
export function changedFiles(root: string, range: ResolvedRange): ChangedFile[] {
  const nameStatus = git(root, ["diff", "--name-status", "-M", "-z", range.base, range.head]);
  const numstat = git(root, ["diff", "--numstat", "-M", "-z", range.base, range.head]);

  const files: ChangedFile[] = [];
  const parts = nameStatus.split("\0").filter((p) => p !== "");
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    const status = STATUS[code[0]] ?? "modified";
    if (status === "renamed" || status === "copied") {
      const previous_path = parts[i++];
      const path = parts[i++];
      files.push({ path, previous_path, status, lines_added: 0, lines_removed: 0, binary: false });
    } else {
      files.push({ path: parts[i++], status, lines_added: 0, lines_removed: 0, binary: false });
    }
  }

  // numstat -z: "<add>\t<del>\t<path>\0" or, for renames, "<add>\t<del>\t\0<old>\0<new>\0".
  const byPath = new Map(files.map((f) => [f.path, f]));
  const tokens = numstat.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(tokens[i]);
    if (!m) continue;
    let path = m[3];
    if (path === "") {
      i += 2;
      path = tokens[i];
    }
    const file = byPath.get(path);
    if (!file) continue;
    file.binary = m[1] === "-";
    file.lines_added = m[1] === "-" ? 0 : Number(m[1]);
    file.lines_removed = m[2] === "-" ? 0 : Number(m[2]);
  }
  return files;
}

/** File content at a revision, or null if absent / too large / binary. */
export function fileAt(root: string, rev: string, path: string, maxBytes = 512 * 1024): string | null {
  if (rev === EMPTY_TREE) return null;
  const size = Number(git(root, ["cat-file", "-s", `${rev}:${path}`], { allowFail: true }).trim());
  if (!Number.isFinite(size) || size === 0 || size > maxBytes) return null;
  const text = git(root, ["show", `${rev}:${path}`], { allowFail: true });
  return text.includes("\0") ? null : text;
}

/** Commit subjects in the range (newest first). */
export function commitSubjects(root: string, range: ResolvedRange, max = 50): string[] {
  const spec = range.base === EMPTY_TREE ? range.head : `${range.base}..${range.head}`;
  return git(root, ["log", "--format=%s", `-n`, String(max), spec], { allowFail: true })
    .split(/\r?\n/)
    .filter(Boolean);
}

/** Files tracked at a revision. */
export function trackedFiles(root: string, rev = "HEAD"): string[] {
  return git(root, ["ls-tree", "-r", "--name-only", "-z", rev], { allowFail: true })
    .split("\0")
    .filter(Boolean);
}

/**
 * Paths marked `linguist-generated` or `linguist-vendored` in .gitattributes —
 * generated or vendored code must not inflate a person's metrics.
 */
export function generatedOrVendored(root: string, paths: string[]): Set<string> {
  const flagged = new Set<string>();
  if (paths.length === 0) return flagged;
  const out = git(root, ["check-attr", "-z", "--stdin", "linguist-generated", "linguist-vendored"], {
    input: paths.join("\0") + "\0",
    allowFail: true,
  });
  // -z output: path\0attr\0value\0 triples.
  const parts = out.split("\0");
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const value = parts[i + 2];
    if (value === "set" || value === "true") flagged.add(parts[i]);
  }
  return flagged;
}

/**
 * L0 symbols: the function context git prints in hunk headers
 * (`@@ -10,4 +10,6 @@ function parseToken(`) for each changed file.
 */
export function hunkSymbols(root: string, range: ResolvedRange, max = 40): string[] {
  const out = git(root, ["diff", "-U0", "--no-color", range.base, range.head], { allowFail: true });
  const seen = new Set<string>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^@@ [^@]+ @@ ?(.*)$/.exec(line);
    if (!m || !m[1]) continue;
    const ident = [...m[1].matchAll(/([A-Za-z_$][\w$]*)\s*[(<:{=]/g)]
      .map((x) => x[1])
      .find((w) => !HUNK_KEYWORDS.has(w));
    if (ident && ident.length > 1) seen.add(ident);
    if (seen.size >= max) break;
  }
  return [...seen];
}

const HUNK_KEYWORDS = new Set([
  "func", "function", "def", "class", "fn", "impl", "if", "for", "while", "switch", "return",
  "async", "public", "private", "protected", "static", "export", "const", "let", "var", "pub", "new",
]);
