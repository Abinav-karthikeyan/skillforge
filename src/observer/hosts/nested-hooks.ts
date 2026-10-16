import { isOurs, readJsonConfig, writeJsonConfig } from "./shared.js";

/**
 * Config writer for hosts that use Claude Code's nested hook layout
 * (`hooks.<Event>[] = { matcher?, hooks: [handler] }`): Codex and Gemini CLI.
 * Marker-based, so install is idempotent and uninstall touches only ours.
 */
type Handler = Record<string, unknown>;
type Group = { matcher?: string; hooks: Handler[] };

export function mergeNestedHooks(path: string, ours: Record<string, Group[]>): void {
  const config = readJsonConfig(path);
  const existing = stripOurs((config.hooks as Record<string, Group[]> | undefined) ?? {});
  for (const [event, groups] of Object.entries(ours)) existing[event] = [...(existing[event] ?? []), ...groups];
  config.hooks = existing;
  writeJsonConfig(path, config);
}

export function removeNestedHooks(path: string): boolean {
  const config = readJsonConfig(path);
  const before = JSON.stringify(config.hooks ?? {});
  const after = stripOurs((config.hooks as Record<string, Group[]> | undefined) ?? {});
  if (before === JSON.stringify(after)) return false;
  if (Object.keys(after).length) config.hooks = after;
  else delete config.hooks;
  writeJsonConfig(path, config);
  return true;
}

function stripOurs(hooks: Record<string, Group[]>): Record<string, Group[]> {
  const out: Record<string, Group[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = (Array.isArray(groups) ? groups : [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) out[event] = kept;
  }
  return out;
}
