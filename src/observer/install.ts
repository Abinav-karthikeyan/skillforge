import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { writeFileAtomic } from "../util/fs.js";

/**
 * `skill-forge observe install` — write the observer hooks into Claude Code's
 * settings.json (user or project scope), merging with whatever is there.
 * Our entries are recognized by their command, so install is idempotent and
 * uninstall removes only what we added.
 */
export const OBSERVE_COMMAND = "skill-forge-observe --host claude-code";
const MARK = "skill-forge-observe";

type HookHandler = { type: string; command?: string; async?: boolean; timeout?: number; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks: HookHandler[] };
type HooksConfig = Record<string, HookGroup[]>;

/**
 * Events and modes. Capture is async everywhere it can be, so it never slows
 * the session; SessionStart (the one-line inbox notice) and SessionEnd (which
 * only spawns the detached reflector within the ~1.5 s budget) run sync.
 */
export function observerHooks(): HooksConfig {
  const asyncHook: HookHandler = { type: "command", command: OBSERVE_COMMAND, async: true };
  const syncHook: HookHandler = { type: "command", command: OBSERVE_COMMAND, timeout: 5 };
  return {
    SessionStart: [{ hooks: [syncHook] }],
    UserPromptSubmit: [{ hooks: [asyncHook] }],
    PostToolUse: [{ hooks: [asyncHook] }],
    PostToolUseFailure: [{ hooks: [asyncHook] }],
    Stop: [{ hooks: [asyncHook] }],
    SubagentStop: [{ hooks: [asyncHook] }],
    PreCompact: [{ hooks: [asyncHook] }],
    PostCompact: [{ hooks: [asyncHook] }],
    SessionEnd: [{ hooks: [syncHook] }],
  };
}

/**
 * The same hooks for the Claude Code plugin, in exec form through the bundled
 * shim (claude-code-integration/hooks/observe-shim.mjs): it runs the globally
 * installed capture bin if there is one and is a silent no-op otherwise, so a
 * plugin without the npm package never surfaces "command not found".
 */
export const PLUGIN_SHIM = "${CLAUDE_PLUGIN_ROOT}/claude-code-integration/hooks/observe-shim.mjs";

export function pluginObserverHooks(): HooksConfig {
  const out: HooksConfig = {};
  for (const [event, groups] of Object.entries(observerHooks())) {
    out[event] = groups.map((g) => ({
      ...g,
      hooks: g.hooks.map(({ command: _command, ...rest }) => ({
        ...rest,
        command: "node",
        args: [PLUGIN_SHIM, "--host", "claude-code"],
      })),
    }));
  }
  return out;
}

export function claudeSettingsPath(scope: "user" | "project", projectDir = process.cwd()): string {
  return scope === "user" ? join(homedir(), ".claude", "settings.json") : join(projectDir, ".claude", "settings.json");
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

const isOurs = (h: HookHandler) => typeof h.command === "string" && h.command.includes(MARK);

/** Remove our handlers from a hooks config; drop groups and events left empty. */
export function withoutObserverHooks(hooks: HooksConfig): HooksConfig {
  const out: HooksConfig = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) out[event] = kept;
  }
  return out;
}

export function installObserverHooks(path: string): { added: string[] } {
  const settings = readSettings(path);
  const existing = withoutObserverHooks((settings.hooks as HooksConfig | undefined) ?? {});
  const ours = observerHooks();
  for (const [event, groups] of Object.entries(ours)) existing[event] = [...(existing[event] ?? []), ...groups];
  settings.hooks = existing;
  writeFileAtomic(path, JSON.stringify(settings, null, 2) + "\n");
  return { added: Object.keys(ours) };
}

export function uninstallObserverHooks(path: string): { removed: boolean } {
  if (!existsSync(path)) return { removed: false };
  const settings = readSettings(path);
  const before = JSON.stringify(settings.hooks ?? {});
  const after = withoutObserverHooks((settings.hooks as HooksConfig | undefined) ?? {});
  if (Object.keys(after).length) settings.hooks = after;
  else delete settings.hooks;
  writeFileAtomic(path, JSON.stringify(settings, null, 2) + "\n");
  return { removed: before !== JSON.stringify(after) };
}
