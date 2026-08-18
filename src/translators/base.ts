import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parse } from "yaml";
import type { CalibrationConfig, CustomInstructions } from "../types/config.js";

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

  const envOverride = process.env.CAREER_MODE_PROMPT_VERSION;
  if (envOverride) {
    if (envOverride.includes("@")) {
      const [mode, ver] = envOverride.split("@");
      if (mode === name) {
        if (!available.includes(ver)) {
          throw new Error(
            `Env CAREER_MODE_PROMPT_VERSION specifies unknown version "${ver}" for "${name}". Available: ${available.join(", ")}`
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
