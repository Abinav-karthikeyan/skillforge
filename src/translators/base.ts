import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parse } from "yaml";
import type { CalibrationConfig, CustomInstructions } from "../types/config.js";
import type { SessionSummary } from "../types/session.js";
import { promptVersionFromEnv, PROMPT_VERSION_ENV } from "../config/paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "../prompts");

interface ManifestEntry {
  active: string;
  versions: Record<string, { notes?: string; tuned_against?: string }>;
}

interface Manifest {
  [mode: string]: ManifestEntry;
}

let _manifest: Manifest | null = null;

function getManifest(): Manifest {
  if (!_manifest) {
    _manifest = parse(
      readFileSync(join(PROMPTS_DIR, "manifest.yaml"), "utf-8")
    ) as Manifest;
  }
  return _manifest;
}

export function resolvePromptVersion(
  name: string,
  explicitVersion?: string
): string {
  const manifest = getManifest();
  const entry = manifest[name];
  const available = entry?.versions ? Object.keys(entry.versions) : [];

  if (explicitVersion) {
    if (!available.includes(explicitVersion)) {
      throw new Error(
        `Unknown version "${explicitVersion}" for prompt "${name}". Available: ${available.join(", ")}`
      );
    }
    return explicitVersion;
  }

  const envOverride = promptVersionFromEnv();
  if (envOverride) {
    if (envOverride.includes("@")) {
      const [mode, ver] = envOverride.split("@");
      if (mode === name) {
        if (!available.includes(ver)) {
          throw new Error(
            `Env ${PROMPT_VERSION_ENV} specifies unknown version "${ver}" for "${name}". Available: ${available.join(", ")}`
          );
        }
        return ver;
      }
    } else if (available.includes(envOverride)) {
      return envOverride;
    }
  }

  return entry?.active ?? "v1";
}

export function loadPrompt(
  name: string,
  explicitVersion?: string
): { content: string; version: string } {
  const version = resolvePromptVersion(name, explicitVersion);
  const content = readFileSync(
    join(PROMPTS_DIR, name, `${version}.txt`),
    "utf-8"
  );
  return { content, version: `${name}@${version}` };
}

export function interpolate(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

/**
 * Resolves the effective custom instruction string for a given mode from
 * the CalibrationConfig, then appends it to the system prompt as a clearly
 * delimited block. Returns the prompt unchanged if no instructions are set.
 */
export function applyCustomInstructions(
  systemPrompt: string,
  config: CalibrationConfig,
  mode: "interview-qa" | "portfolio-bullet" | "technical-deep-dive"
): string {
  const ci = config.custom_instructions;
  if (!ci) return systemPrompt;

  const parts: string[] = [];

  if (typeof ci === "string") {
    parts.push(ci.trim());
  } else {
    if (ci.global) parts.push(ci.global.trim());
    if (ci[mode]) parts.push((ci[mode] as string).trim());
  }

  if (parts.length === 0) return systemPrompt;

  const block = [
    "",
    "---",
    "Additional context from the user (apply throughout your response):",
    ...parts.map((p) => p.replace(/^/gm, "  ")),
    "---",
  ].join("\n");

  return systemPrompt + block;
}

const CODE_FACTS_RULE = [
  "",
  "---",
  "Code facts rule — the summary carries deterministic measurements in `code_facts`:",
  "  - Numbers, counts, and metrics (files, lines, entities, cyclomatic complexity, references, tests)",
  "    may ONLY come from `code_facts`, or from figures stated verbatim elsewhere in the summary.",
  "    Never estimate, round up, or derive new numbers.",
  "  - Blast-radius entries with `approximate: true` are name-based: write them as \"~N\" or",
  "    \"about N\", never as an exact count.",
  "  - Prefer the concrete entity names in `code_facts` (e.g. a function whose complexity went",
  "    from 14 to 6, a newly exported interface) over generic descriptions.",
  "  - Frame the work to match `code_facts.classification`: a refactor is told as what got",
  "    simpler and why, not as new functionality.",
  "  - If `code_facts.attribution` shows AI-written lines, describe that work as AI-assisted",
  "    (what the engineer directed, reviewed, and decided) — never imply sole authorship of it.",
  "---",
].join("\n");

/**
 * When a session carries code facts (v3 Pillar A), constrain every metric in
 * the artifact to them. Sessions without code facts render exactly as before.
 */
export function applyCodeFactsRule(systemPrompt: string, session: SessionSummary): string {
  return session.summary.code_facts ? systemPrompt + CODE_FACTS_RULE : systemPrompt;
}
