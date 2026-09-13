/**
 * Single source of truth for every user-global path, config filename, and the
 * prompt-version env var. Before this module those strings were duplicated
 * across ~10 files; centralizing them is P0.1 Increment A — a pure refactor
 * that changes no behavior. Increment B then flips the historical
 * `career-mode` names to `skill-forge` (with a one-release read-fallback) by
 * editing *this file only*.
 *
 * Leaf module: depends on `os`/`path` only, so anything may import it without
 * risking a cycle.
 */
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** The user-global config directory (holds `.env`, `config.yaml`, `artifacts/`). */
export function configDir(): string {
  return join(homedir(), ".career-mode");
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
export const CONFIG_FILENAME = "career-mode.config.yaml";

/** Path to the project-local config file in the current working directory. */
export function projectConfigPath(): string {
  return join(process.cwd(), CONFIG_FILENAME);
}

/**
 * The default artifacts directory, kept as a leading-`~` string so it stays
 * serializable as a config default. Use `resolveArtifactsDir()` to get an
 * absolute path.
 */
export const DEFAULT_ARTIFACTS_DIR = "~/.career-mode/artifacts";

/** Expand a leading `~/` to the user's home directory; pass through otherwise. */
export function expandTilde(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(2)) : p;
}

/**
 * Resolve an artifacts directory to an absolute path, falling back to the
 * default when no preference is given.
 */
export function resolveArtifactsDir(preferred?: string): string {
  return expandTilde(preferred ?? DEFAULT_ARTIFACTS_DIR);
}

/** Name of the env var that overrides the active prompt version. */
export const PROMPT_VERSION_ENV = "CAREER_MODE_PROMPT_VERSION";

/**
 * Read the prompt-version override from the environment. Returns the raw value
 * (which may be a bare version like `v2` or a per-mode `interview-qa@v1`), or
 * `undefined` when unset. Increment B aliases the successor var name here.
 */
export function promptVersionFromEnv(): string | undefined {
  return process.env[PROMPT_VERSION_ENV];
}
