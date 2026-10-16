import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { copilotAdapter } from "./copilot.js";
import { cursorAdapter } from "./cursor.js";
import { geminiAdapter } from "./gemini.js";
import { gitAdapter } from "./git.js";
import { kiroAdapter } from "./kiro.js";
import { HostAdapter, HostName } from "./types.js";

export const HOST_ADAPTERS: Readonly<Record<HostName, HostAdapter>> = Object.freeze({
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  "gemini-cli": geminiAdapter,
  copilot: copilotAdapter,
  kiro: kiroAdapter,
  git: gitAdapter,
});

/** Aliases accepted on the command line. */
const ALIASES: Record<string, HostName> = { claude: "claude-code", gemini: "gemini-cli", "copilot-cli": "copilot" };

export function getHostAdapter(name: string): HostAdapter | null {
  const key = (ALIASES[name] ?? name) as HostName;
  return HOST_ADAPTERS[key] ?? null;
}

export interface DetectedHost {
  adapter: HostAdapter;
  detected: boolean;
}

/** Every adapter with whether its host is present (git is repo-scoped). */
export function detectHosts(home: string): DetectedHost[] {
  return Object.values(HOST_ADAPTERS).map((adapter) => {
    let detected = false;
    try {
      detected = adapter.detect(home);
    } catch {
      detected = false;
    }
    return { adapter, detected };
  });
}

/** Hosts `observe install --all` writes: detected, schema not unverified, agent hosts only. */
export function autoInstallTargets(home: string): HostAdapter[] {
  return detectHosts(home)
    .filter((h) => h.detected && h.adapter.confidence !== "unverified" && h.adapter.name !== "git")
    .map((h) => h.adapter);
}
