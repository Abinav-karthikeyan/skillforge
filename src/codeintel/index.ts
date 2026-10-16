/**
 * Code intelligence (plan_v3 Pillar A). Deterministic, LLM-free facts about a
 * change: entity-level structural diff, cyclomatic complexity, public API
 * changes, test linkage, approximate blast radius, a repo map, and a
 * fingerprint. Layered:
 *
 *   L0  git only — always available
 *   L1  tree-sitter via the optional @abhinavravich1999/skill-forge-codeintel
 *       companion (auto-detected; see ./runtime.ts)
 *   L2  LSP — supplied by the host agent (SKILL.md), never bundled
 */
export { buildStructuralDigest, renderDigest, MAX_FACT_CHANGES } from "./digest.js";
export type { StructuralDigest, DigestFile, DigestOptions } from "./digest.js";
export { loadCodeIntelRuntime, codeIntelStatus, CODEINTEL_PACKAGE } from "./runtime.js";
export type { CodeIntelStatus } from "./runtime.js";
export { EntityExtractor, extractFromTree, cyclomaticComplexity } from "./entities.js";
export { diffFileEntities } from "./diff.js";
export { buildRepoGraph, rankFiles, renderRepoMap } from "./repo-map.js";
export { LANGUAGES, languageForPath } from "./languages.js";
export { isGitRepo } from "./git.js";
