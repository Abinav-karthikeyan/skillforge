/**
 * @abhinavravich1999/skill-forge-codeintel
 *
 * The optional half of skill-forge's code intelligence (plan_v3 Pillar A):
 * the web-tree-sitter runtime and a fixed set of vendored grammars. All the
 * analysis logic lives in skill-forge core (src/codeintel), which imports this
 * package when it is installed and degrades to git-only facts (L0) when not.
 *
 * WASM rather than native tree-sitter so it behaves identically on every OS
 * and never needs a compiler at install time.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, Query } from "web-tree-sitter";

const here = dirname(fileURLToPath(import.meta.url));
const grammarsDir = join(here, "grammars");

/** Grammar id → vendored WASM file. */
export const GRAMMARS = Object.freeze({
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
  rust: "tree-sitter-rust.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
});

export const VERSION = JSON.parse(readFileSync(join(here, "package.json"), "utf-8")).version;

/** Absolute path to a grammar's WASM, or null if the id is unknown / file missing. */
export function grammarPath(id) {
  const file = GRAMMARS[id];
  if (!file) return null;
  const path = join(grammarsDir, file);
  return existsSync(path) ? path : null;
}

let ready;

/**
 * Initialize the WASM runtime once and hand back what core needs. Core types
 * this structurally, so core never takes a dependency on web-tree-sitter.
 */
export async function loadRuntime() {
  ready ??= Parser.init();
  await ready;
  return {
    version: VERSION,
    grammars: Object.keys(GRAMMARS),
    grammarPath,
    createParser: () => new Parser(),
    loadLanguage: (path) => Language.load(path),
    createQuery: (language, source) => new Query(language, source),
  };
}
