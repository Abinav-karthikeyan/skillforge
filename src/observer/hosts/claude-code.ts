import { join } from "path";
import { ClaudeCodePayload, normalizeClaudeCode } from "../normalize.js";
import { installObserverHooks, observerHooks, uninstallObserverHooks } from "../install.js";
import { dirExists, onPath, str } from "./shared.js";
import { HostAdapter, InstallContext } from "./types.js";

/** Claude Code — the reference host (hooks reference: code.claude.com/docs/en/hooks). */
export const claudeCodeAdapter: HostAdapter = {
  name: "claude-code",
  label: "Claude Code",
  confidence: "verified",
  docs: "https://code.claude.com/docs/en/hooks",
  parse(raw) {
    return {
      sessionId: str(raw.session_id),
      cwd: str(raw.cwd),
      transcriptPath: str(raw.transcript_path),
      events: normalizeClaudeCode(raw as ClaudeCodePayload),
    };
  },
  detect: (home) => dirExists(home, ".claude") || onPath("claude"),
  configPath: (ctx: InstallContext) =>
    ctx.scope === "user" ? join(ctx.home, ".claude", "settings.json") : join(ctx.projectDir, ".claude", "settings.json"),
  install(ctx) {
    const path = this.configPath(ctx);
    installObserverHooks(path);
    return { path, events: Object.keys(observerHooks()) };
  },
  uninstall(ctx) {
    const path = this.configPath(ctx);
    return { path, removed: uninstallObserverHooks(path).removed };
  },
};
