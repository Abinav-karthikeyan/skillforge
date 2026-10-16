/**
 * Single source of truth for every user-global path, config filename, and the
 * prompt-version env var. Before this module those strings were duplicated
 * across ~10 files; centralizing them was P0.1 Increment A.
 *
 * Increment B (this file) flips the historical `career-mode` names to
 * `skill-forge`. Each flip carries a ONE-RELEASE read-fallback so existing
 * users' `~/.career-mode/` data, `career-mode.config.yaml`, and
 * `CAREER_MODE_PROMPT_VERSION` env var keep working. The fallbacks live here
 * and only here — delete the `LEGACY_*` constants and the existence checks in
 * the next release to complete the migration.
 *
 * Leaf module: depends on `os`/`path` only, so anything may import it without
 * risking a cycle.
 */
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG_DIRNAME = ".skill-forge";
/** One-release read-fallback: existing installs keep using `~/.career-mode/`. */
const LEGACY_CONFIG_DIRNAME = ".career-mode";

/**
 * The user-global config directory (holds `.env`, `config.yaml`, `artifacts/`).
 * Prefers `~/.skill-forge/`, but if only the legacy `~/.career-mode/` exists it
 * is returned unchanged so an existing user's data is not orphaned. Fresh
 * installs always get the new directory.
 */
export function configDir(): string {
  const preferred = join(homedir(), CONFIG_DIRNAME);
  if (existsSync(preferred)) return preferred;
  const legacy = join(homedir(), LEGACY_CONFIG_DIRNAME);
  if (existsSync(legacy)) return legacy;
  return preferred;
}

/** `configDir()`, created if missing. Returned so callers can write into it. */
export function ensureConfigDir(): string {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Path to the user-global `.env` (fallback secrets for a global install). */
export function envPath(): string {
  return join(configDir(), ".env");
}

/** Path to the user-global `config.yaml`. */
export function configYamlPath(): string {
  return join(configDir(), "config.yaml");
}

/** Basename of the project-local config file. */
export const CONFIG_FILENAME = "skill-forge.config.yaml";
/** One-release read-fallback for the project-local config filename. */
const LEGACY_CONFIG_FILENAME = "career-mode.config.yaml";

/**
 * Path to the project-local config file in the current working directory.
 * Prefers `skill-forge.config.yaml`; falls back to the legacy
 * `career-mode.config.yaml` if only that exists.
 */
export function projectConfigPath(): string {
  const preferred = join(process.cwd(), CONFIG_FILENAME);
  if (existsSync(preferred)) return preferred;
  const legacy = join(process.cwd(), LEGACY_CONFIG_FILENAME);
  if (existsSync(legacy)) return legacy;
  return preferred;
}

/**
 * The default artifacts directory as a serializable leading-`~` string, used
 * only when writing a fresh config file. Runtime resolution goes through
 * `resolveArtifactsDir()`, which derives the path from `configDir()` so it
 * honors the legacy-directory fallback.
 */
export const DEFAULT_ARTIFACTS_DIR = "~/.skill-forge/artifacts";

/** Expand a leading `~/` to the user's home directory; pass through otherwise. */
export function expandTilde(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(2)) : p;
}

/**
 * Resolve an artifacts directory to an absolute path. An explicit preference
 * (CLI flag or config `output_dir`) wins; otherwise the default is derived from
 * `configDir()` so it follows the legacy `~/.career-mode/` fallback rather than
 * a hardcoded new-dir string.
 */
export function resolveArtifactsDir(preferred?: string): string {
  if (preferred) return expandTilde(preferred);
  return join(configDir(), "artifacts");
}

/**
 * The story ledger (stories, observations, evidence) for an artifacts
 * directory. It lives beside the artifacts it versions — as a dot-dir so it
 * stays out of the way when output_dir points at a notes vault — which keeps
 * `index.yml` and the ledger it is migrated into in one place.
 */
export function ledgerDirFor(artifactsDir: string): string {
  return join(artifactsDir, ".ledger");
}

/** User-global log directory (hook runs, background workers). */
export function logsDir(): string {
  return join(configDir(), "logs");
}

/** Name of the env var that overrides the active prompt version. */
export const PROMPT_VERSION_ENV = "SKILL_FORGE_PROMPT_VERSION";
/** One-release alias for the prompt-version env var. */
const LEGACY_PROMPT_VERSION_ENV = "CAREER_MODE_PROMPT_VERSION";

/**
 * Read the prompt-version override from the environment. Returns the raw value
 * (which may be a bare version like `v2` or a per-mode `interview-qa@v1`), or
 * `undefined` when unset. The successor var wins; the legacy var is still
 * honored for one release.
 */
export function promptVersionFromEnv(): string | undefined {
  return process.env[PROMPT_VERSION_ENV] ?? process.env[LEGACY_PROMPT_VERSION_ENV];
}
