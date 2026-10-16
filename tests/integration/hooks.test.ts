import { existsSync, readFileSync } from "fs";
import { observerHooks, pluginObserverHooks } from "../../src/observer/install.js";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { parseHookPayload, runPostCommitHook, shouldProcess } from "../../src/hooks/post-commit.js";
import { VERSION } from "../../src/version.js";

const root = join(__dirname, "..", "..");

describe("reference commit hook config (claude-code-integration/hooks/post-session.json)", () => {
  const config = JSON.parse(
    readFileSync(join(root, "claude-code-integration", "hooks", "post-session.json"), "utf-8")
  );

  it("uses the current nested hooks schema with an `if` filter instead of `pattern`", () => {
    const group = config.hooks.PostToolUse[0];
    expect(group.matcher).toBe("Bash");
    expect(group).not.toHaveProperty("pattern");
    expect(group).not.toHaveProperty("command");
    expect(group.hooks).toHaveLength(1);
    const handler = group.hooks[0];
    expect(handler.type).toBe("command");
    expect(handler.if).toBe("Bash(git commit*)");
  });

  it("runs async and calls the installed bin, not npx", () => {
    const handler = config.hooks.PostToolUse[0].hooks[0];
    expect(handler.async).toBe(true);
    expect(handler.command).toMatch(/^skill-forge hook post-commit\b/);
    expect(handler.command).not.toMatch(/npx/);
  });
});

describe("post-commit hook gate", () => {
  it("tolerates empty or malformed stdin", () => {
    expect(parseHookPayload(undefined)).toEqual({});
    expect(parseHookPayload("")).toEqual({});
    expect(parseHookPayload("{not json")).toEqual({});
    expect(parseHookPayload("42")).toEqual({});
  });

  it("processes git commits and skips everything else", () => {
    const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
    expect(shouldProcess(bash('git commit -m "x"')).ok).toBe(true);
    expect(shouldProcess(bash("git add . && git commit -am wip")).ok).toBe(true);
    expect(shouldProcess(bash("git -C repo commit --amend")).ok).toBe(true);
    expect(shouldProcess(bash("git status")).ok).toBe(false);
    expect(shouldProcess(bash("echo commit")).ok).toBe(false);
    expect(shouldProcess({ tool_name: "Edit", tool_input: {} }).ok).toBe(false);
    // No payload at all (e.g. a plain git post-commit hook) still runs.
    expect(shouldProcess({}).ok).toBe(true);
  });

  it("returns without generating (or calling an LLM) for a non-commit payload", async () => {
    const result = await runPostCommitHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }));
    expect(result).toEqual({ ran: false, reason: "not a git commit" });
  });
});

describe("Claude Code plugin packaging", () => {
  const read = (...p: string[]) => JSON.parse(readFileSync(join(root, ...p), "utf-8"));
  const plugin = read(".claude-plugin", "plugin.json");

  it("tracks the package version and points at files that exist", () => {
    expect(plugin.name).toBe("skill-forge");
    expect(plugin.version).toBe(read("package.json").version);
    for (const dir of plugin.commands) expect(existsSync(join(root, dir))).toBe(true);
    expect(existsSync(join(root, plugin.hooks))).toBe(true);
    expect(existsSync(join(root, "skills", "skill-forge", "SKILL.md"))).toBe(true);
    expect(plugin.mcpServers["skill-forge"].command).toBe("skill-forge-mcp");
  });

  it("ships the observer hooks through the no-op-safe shim", () => {
    expect(read(...plugin.hooks.split("/").slice(1))).toEqual({ hooks: pluginObserverHooks() });
    // Same events and async/sync split as `skill-forge observe install`.
    const strip = (h: object) => JSON.parse(JSON.stringify(h, (k, v) => (k === "command" || k === "args" ? undefined : v)));
    expect(strip(pluginObserverHooks())).toEqual(strip(observerHooks()));
    expect(existsSync(join(root, "claude-code-integration", "hooks", "observe-shim.mjs"))).toBe(true);
  });

  it("lists itself in the repo marketplace", () => {
    const market = read(".claude-plugin", "marketplace.json");
    expect(market.plugins).toEqual([expect.objectContaining({ name: "skill-forge", source: "./" })]);
  });

  it("registers the lightweight capture bin", () => {
    expect(read("package.json").bin["skill-forge-observe"]).toBe("dist/observer/observe-bin.js");
  });
});

describe("version", () => {
  it("is read from package.json", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    expect(VERSION).toBe(pkg.version);
  });
});
