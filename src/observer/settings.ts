import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { configDir } from "../config/paths.js";
import { writeFileAtomic } from "../util/fs.js";

/**
 * Observer settings — `~/.skill-forge/observe.json`. JSON rather than YAML so
 * the capture hot path can read it without loading a parser. Observation is
 * OFF by default and enabled per repository (plan_v3 §3.4).
 */
export interface ObserveSettings {
  /** Repository roots where observation is enabled. */
  enabled: string[];
  /** Enabled repos treated as confidential: local observer model, names abstracted. */
  confidential: string[];
  /** One-line "N story candidates" notice at session start. */
  notify: boolean;
  /** Opt-in: at most one clarifying question per session for a high-value, low-confidence item. */
  question: boolean;
  /** Warm-path observer: "auto" runs at milestones, "off" captures only. */
  observer: "auto" | "off";
  max_observer_calls_per_hour: number;
  /** Raw journal TTL. Observations and stories persist. */
  retention_days: number;
  /** Flush an observation after this many tool events at a Stop. */
  flush_after_tool_calls: number;
  /** A test command failing this many times, then passing, is a debugging arc. */
  debug_arc_min_failures: number;
  /** Seconds between observer runs for one session (debounce). */
  observer_min_interval_s: number;
}

export const DEFAULT_OBSERVE_SETTINGS: ObserveSettings = {
  enabled: [],
  confidential: [],
  notify: true,
  question: false,
  observer: "auto",
  max_observer_calls_per_hour: 6,
  retention_days: 30,
  flush_after_tool_calls: 25,
  debug_arc_min_failures: 2,
  observer_min_interval_s: 120,
};

export function observeSettingsPath(): string {
  return join(configDir(), "observe.json");
}

export function loadObserveSettings(path = observeSettingsPath()): ObserveSettings {
  try {
    if (!existsSync(path)) return { ...DEFAULT_OBSERVE_SETTINGS };
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<ObserveSettings>;
    return { ...DEFAULT_OBSERVE_SETTINGS, ...raw };
  } catch {
    // A broken settings file must never break the host: treat as "nothing enabled".
    return { ...DEFAULT_OBSERVE_SETTINGS };
  }
}

export function saveObserveSettings(settings: ObserveSettings, path = observeSettingsPath()): void {
  writeFileAtomic(path, JSON.stringify(settings, null, 2) + "\n");
}

/** Normalize a path for allowlist comparison (case-insensitive on Windows). */
export function normalizeRepoPath(p: string): string {
  const abs = resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/** Walk up from `start` to the directory containing `.git` (file or dir). No git process. */
export function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 64; i++) {
    const marker = join(dir, ".git");
    try {
      if (existsSync(marker) && (statSync(marker).isDirectory() || statSync(marker).isFile())) return dir;
    } catch {
      /* unreadable — keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export interface RepoPolicy {
  repo: string | null;
  enabled: boolean;
  confidential: boolean;
}

/** Is observation enabled for the repository containing `cwd`? */
export function repoPolicy(cwd: string, settings: ObserveSettings): RepoPolicy {
  const repo = findRepoRoot(cwd);
  if (!repo) return { repo: null, enabled: false, confidential: false };
  const key = normalizeRepoPath(repo);
  return {
    repo,
    enabled: settings.enabled.some((p) => normalizeRepoPath(p) === key),
    confidential: settings.confidential.some((p) => normalizeRepoPath(p) === key),
  };
}
