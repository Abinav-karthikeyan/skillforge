import { createRequire } from "module";
import { join } from "path";
import { pathToFileURL } from "url";
import { CodeIntelRuntime } from "./types.js";

/** The optional companion that supplies web-tree-sitter + grammars. */
export const CODEINTEL_PACKAGE = "@abhinavravich1999/skill-forge-codeintel";

interface CompanionModule {
  loadRuntime(): Promise<CodeIntelRuntime>;
}

let cached: Promise<CodeIntelRuntime | null> | undefined;
let lastError: string | undefined;

async function importCompanion(): Promise<CompanionModule> {
  // Kept in a variable so tsc does not try to resolve an optional package.
  const spec: string = CODEINTEL_PACKAGE;
  try {
    // Resolves next to skill-forge: a sibling global install, the same npx
    // invocation (`npx -p skill-forge -p skill-forge-codeintel`), or the dev workspace.
    return (await import(spec)) as CompanionModule;
  } catch (first) {
    // Fall back to the current project's node_modules (installed as a devDependency).
    try {
      const fromCwd = createRequire(join(process.cwd(), "noop.js")).resolve(spec);
      return (await import(pathToFileURL(fromCwd).href)) as CompanionModule;
    } catch {
      throw first;
    }
  }
}

/**
 * Load the tree-sitter runtime once per process. Resolves `null` when the
 * companion isn't installed (or fails to initialize) — every caller must
 * degrade to L0 (git-only facts) in that case rather than fail.
 *
 * `SKILL_FORGE_CODEINTEL=off` forces L0, for comparisons and debugging.
 */
export function loadCodeIntelRuntime(): Promise<CodeIntelRuntime | null> {
  if (process.env.SKILL_FORGE_CODEINTEL === "off") return Promise.resolve(null);
  cached ??= importCompanion()
    .then((mod) => mod.loadRuntime())
    .catch((err: Error) => {
      lastError = err.message;
      return null;
    });
  return cached;
}

/** Test hook: forget the cached runtime so the next load re-resolves. */
export function resetCodeIntelRuntime(): void {
  cached = undefined;
  lastError = undefined;
}

export interface CodeIntelStatus {
  layer: "L0" | "L1";
  package?: string;
  version?: string;
  grammars: string[];
  reason?: string;
}

export async function codeIntelStatus(): Promise<CodeIntelStatus> {
  const runtime = await loadCodeIntelRuntime();
  if (!runtime) {
    return {
      layer: "L0",
      grammars: [],
      reason:
        process.env.SKILL_FORGE_CODEINTEL === "off"
          ? "disabled by SKILL_FORGE_CODEINTEL=off"
          : `${CODEINTEL_PACKAGE} not installed${lastError ? ` (${lastError.split("\n")[0]})` : ""}`,
    };
  }
  return {
    layer: "L1",
    package: CODEINTEL_PACKAGE,
    version: runtime.version,
    grammars: runtime.grammars.filter((g) => runtime.grammarPath(g) !== null),
  };
}
