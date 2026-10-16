import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capturePayload } from "../../src/observer/capture.js";
import { Signal } from "../../src/observer/detectors.js";
import { autoInstallTargets, detectHosts, getHostAdapter, HOST_ADAPTERS } from "../../src/observer/hosts/registry.js";
import { hooksDir } from "../../src/observer/hosts/git.js";
import { patchOperations } from "../../src/observer/hosts/codex.js";
import { looksFailed } from "../../src/observer/hosts/shared.js";
import { importEntireCheckpoints, parseCheckpointList } from "../../src/observer/importers/entire.js";
import { attributionFor, readAgentTraces, storeAgentTraces, loadAgentTraces } from "../../src/codeintel/attribution.js";
import { buildStructuralDigest, renderDigest } from "../../src/codeintel/digest.js";
import { FIXTURE_NAMES, loadSessionFixture, ObserverSandbox } from "./helpers.js";

let box: ObserverSandbox;
beforeEach(() => {
  box = new ObserverSandbox({ observer: "off" });
});
afterEach(() => box.dispose());

// ── translating the gold Claude Code fixtures into other hosts' payload shapes ──
// Synthesized from each host's documented schema (not recorded sessions).
type P = Record<string, unknown>;
const cmd = (p: P) => String((p.tool_input as P | undefined)?.command ?? "");
const path = (p: P) => String((p.tool_input as P | undefined)?.file_path ?? "");
const out = (p: P) => String((p.tool_response as P | undefined)?.stdout ?? "");

function toHost(host: string, p: P, session: string, cwd: string): { payload: P; event?: string } | null {
  const ev = p.hook_event_name;
  const created = p.tool_name === "Write" && (p.tool_response as P)?.type === "create";
  switch (host) {
    case "codex": {
      const base = { session_id: session, cwd, transcript_path: undefined, model: "gpt-5" };
      if (ev === "PostToolUseFailure") {
        return { payload: { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: ["bash", "-lc", cmd(p)] }, tool_response: { output: p.error, exit_code: 1 } } };
      }
      if (ev === "PostToolUse" && p.tool_name === "Bash") {
        return { payload: { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: ["bash", "-lc", cmd(p)] }, tool_response: { output: out(p), exit_code: 0 } } };
      }
      if (ev === "PostToolUse" && (p.tool_name === "Write" || p.tool_name === "Edit")) {
        const verb = created ? "Add" : "Update";
        return { payload: { ...base, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { input: `*** Begin Patch\n*** ${verb} File: ${path(p)}\n*** End Patch` } } };
      }
      return { payload: { ...p, ...base } };
    }
    case "cursor": {
      const base = { conversation_id: session, generation_id: "g", workspace_roots: [cwd] };
      if (ev === "SessionStart") return { payload: { ...base, hook_event_name: "sessionStart", session_id: session, is_background_agent: false } };
      if (ev === "SessionEnd") return { payload: { ...base, hook_event_name: "sessionEnd", session_id: session, reason: "user_closed" } };
      if (ev === "UserPromptSubmit") return { payload: { ...base, hook_event_name: "beforeSubmitPrompt", prompt: p.prompt } };
      if (ev === "PostToolUseFailure") return { payload: { ...base, hook_event_name: "afterShellExecution", command: cmd(p), output: p.error } };
      if (ev === "PostToolUse" && p.tool_name === "Bash") return { payload: { ...base, hook_event_name: "afterShellExecution", command: cmd(p), output: out(p) } };
      if (ev === "PostToolUse" && (p.tool_name === "Write" || p.tool_name === "Edit")) {
        return { payload: { ...base, hook_event_name: "afterFileEdit", file_path: path(p), edits: [{ old_string: created ? "" : "a", new_string: "b" }] } };
      }
      if (ev === "Stop") return { payload: { ...base, hook_event_name: "stop", status: "completed", loop_count: 0 } };
      if (ev === "PreCompact") return { payload: { ...base, hook_event_name: "preCompact", trigger: p.trigger } };
      return null;
    }
    case "gemini-cli": {
      const base = { session_id: session, cwd, transcript_path: "", timestamp: "2026-10-16T10:00:00Z" };
      if (ev === "SessionStart") return { payload: { ...base, hook_event_name: "SessionStart", source: "startup" } };
      if (ev === "SessionEnd") return { payload: { ...base, hook_event_name: "SessionEnd", reason: "exit" } };
      if (ev === "UserPromptSubmit") return { payload: { ...base, hook_event_name: "BeforeAgent", prompt: p.prompt } };
      if (ev === "Stop") return { payload: { ...base, hook_event_name: "AfterAgent", prompt_response: p.last_assistant_message } };
      if (ev === "PreCompact") return { payload: { ...base, hook_event_name: "PreCompress", trigger: p.trigger } };
      if (ev === "PostToolUseFailure") {
        return { payload: { ...base, hook_event_name: "AfterTool", tool_name: "run_shell_command", tool_input: { command: cmd(p) }, tool_response: { llmContent: p.error, returnDisplay: p.error, error: p.error } } };
      }
      if (ev === "PostToolUse" && p.tool_name === "Bash") {
        return { payload: { ...base, hook_event_name: "AfterTool", tool_name: "run_shell_command", tool_input: { command: cmd(p) }, tool_response: { llmContent: out(p), returnDisplay: out(p) } } };
      }
      if (ev === "PostToolUse" && (p.tool_name === "Write" || p.tool_name === "Edit")) {
        const tool = p.tool_name === "Write" ? "write_file" : "replace";
        const msg = created ? `Successfully created and wrote to new file: ${path(p)}.` : `Successfully modified file: ${path(p)}.`;
        return { payload: { ...base, hook_event_name: "AfterTool", tool_name: tool, tool_input: { file_path: path(p) }, tool_response: { llmContent: msg, returnDisplay: msg } } };
      }
      return null;
    }
    case "copilot": {
      const base = { sessionId: session, timestamp: Date.now(), cwd };
      if (ev === "SessionStart") return { payload: { ...base, source: "new" }, event: "sessionStart" };
      if (ev === "SessionEnd") return { payload: { ...base, reason: "complete" }, event: "sessionEnd" };
      if (ev === "UserPromptSubmit") return { payload: { ...base, prompt: p.prompt }, event: "userPromptSubmitted" };
      if (ev === "Stop") return { payload: { ...base, stopReason: "end_turn", stop_hook_active: false }, event: "agentStop" };
      if (ev === "PreCompact") return { payload: { ...base, trigger: p.trigger }, event: "preCompact" };
      if (ev === "PostToolUseFailure") return { payload: { ...base, toolName: "bash", toolArgs: { command: cmd(p) }, error: p.error }, event: "postToolUseFailure" };
      if (ev === "PostToolUse" && p.tool_name === "Bash") {
        return { payload: { ...base, toolName: "bash", toolArgs: JSON.stringify({ command: cmd(p) }), toolResult: { resultType: "success", textResultForLlm: out(p) } }, event: "postToolUse" };
      }
      if (ev === "PostToolUse" && (p.tool_name === "Write" || p.tool_name === "Edit")) {
        return { payload: { ...base, toolName: created ? "create" : "edit", toolArgs: { path: path(p) }, toolResult: { resultType: "success", textResultForLlm: "ok" } }, event: "postToolUse" };
      }
      return null;
    }
  }
  return null;
}

describe("cross-host replay: same gold sessions, every verified host (deterministic recall)", () => {
  for (const host of ["codex", "cursor", "gemini-cli", "copilot"]) {
    for (const name of FIXTURE_NAMES) {
      it(`${host} · ${name}`, () => {
        const fx = loadSessionFixture(name);
        const signals: Signal[] = [];
        let recorded = 0;
        for (const p of fx.payloads) {
          const t = toHost(host, p, fx.session_id, box.repo.root);
          if (!t) continue;
          const r = capturePayload(JSON.stringify(t.payload), { host, eventName: t.event, settings: box.settings, journal: box.journal, spawn: () => true });
          signals.push(...r.signals);
          recorded += r.recorded.length;
        }
        const of = (k: Signal["kind"]) => signals.filter((s) => s.kind === k);
        for (const g of fx.gold.dead_ends) expect(of("dead_end").map((s) => s.detail).join(" | ")).toContain(g.detector);
        for (const g of fx.gold.debug_arcs) expect(of("debug_arc").map((s) => s.detail).join(" | ")).toContain(g.detector);
        expect(of("tradeoff_candidate").length).toBeGreaterThanOrEqual(fx.gold.tradeoffs.length);
        expect(of("checkpoint")).toHaveLength(fx.gold.checkpoints);
        expect(of("snapshot")).toHaveLength(fx.gold.snapshots);
        // Journals are namespaced per host.
        expect(box.journal.exists(`${host}:${fx.session_id}`)).toBe(true);
        expect(box.journal.loadState(`${host}:${fx.session_id}`)!.host).toBe(host);
        expect(recorded).toBeGreaterThan(5);
      });
    }
  }
});

describe("host payload details", () => {
  it("codex: reads apply_patch operations and argv shell commands", () => {
    expect(patchOperations("*** Begin Patch\n*** Add File: a.ts\n*** Update File: b.ts\n*** Delete File: c.ts\n*** End Patch")).toEqual([
      { op: "create", path: "a.ts" },
      { op: "edit", path: "b.ts" },
      { op: "delete", path: "c.ts" },
    ]);
    const parsed = HOST_ADAPTERS.codex.parse(
      { hook_event_name: "PostToolUse", session_id: "s", cwd: "/r", tool_name: "Bash", tool_input: { command: ["bash", "-lc", "npm test"] }, tool_response: { output: "Error", exit_code: 2 } },
      { cwd: "/", now: new Date() }
    )!;
    expect(parsed.events[0]).toMatchObject({ kind: "test_run", payload: { runner: "npm test", passed: false, exit_code: 2 } });
  });

  it("cursor: acknowledges beforeSubmitPrompt so a prompt is never blocked", () => {
    const r = capturePayload(JSON.stringify({ hook_event_name: "beforeSubmitPrompt", prompt: "x", conversation_id: "c", workspace_roots: ["/nowhere"] }), {
      host: "cursor", settings: box.settings, journal: box.journal, spawn: () => true,
    });
    expect(r.output).toEqual({ continue: true });
  });

  it("infers failure from output only on clear markers", () => {
    expect(looksFailed("Tests 14 passed (14)")).toBeNull();
    expect(looksFailed("0 failed, 12 passed")).toBeNull();
    expect(looksFailed("exit code: 0")).toBeNull();
    expect(looksFailed("2 failed, 10 passed")).toBe(1);
    expect(looksFailed("--- FAIL: TestX")).toBe(1);
    expect(looksFailed("Process exited with code 3")).toBe(3);
    expect(looksFailed("Traceback (most recent call last):\n  ...")).toBe(1);
  });

  it("kiro [unverified]: reads likely keys tolerantly", () => {
    const parsed = HOST_ADAPTERS.kiro.parse({ trigger: "PostFileCreate", sessionId: "k1", cwd: "/r", filePath: "src/x.ts" }, { cwd: "/", now: new Date() })!;
    expect(parsed).toMatchObject({ sessionId: "k1", cwd: "/r" });
    expect(parsed.events[0]).toMatchObject({ kind: "file_edit", payload: { op: "create", path: "src/x.ts" } });
  });

  it("ignores unknown hosts", () => {
    expect(capturePayload("{}", { host: "notepad", settings: box.settings, journal: box.journal }).skipped).toMatch(/unknown host/);
    expect(getHostAdapter("gemini")?.name).toBe("gemini-cli");
  });
});

describe("git floor", () => {
  const commit = (msg: string) => {
    box.repo.write({ [`f-${msg}.txt`]: msg }).commit(msg);
    return box.repo.git("rev-parse", "HEAD").trim();
  };

  it("records a post-commit checkpoint in a per-repo daily session", () => {
    const sha = commit("first");
    const prev = process.cwd();
    process.chdir(box.repo.root);
    try {
      const r = capturePayload("", { host: "git", settings: { ...box.settings }, journal: box.journal, now: () => new Date("2026-10-16T12:00:00Z"), spawn: () => true });
      expect(r.signals.map((s) => s.kind)).toEqual(["checkpoint"]);
      const sessions = box.journal.sessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatch(/^git:[0-9a-f]{10}:2026-10-16$/);
      expect(box.journal.readEvents(sessions[0])[0].payload).toMatchObject({ sha: sha.slice(0, 12), message: "first" });
    } finally {
      process.chdir(prev);
    }
  });

  it("dedupes a commit seen by both an agent hook and post-commit, in either order", () => {
    const sha = commit("dup");
    const prev = process.cwd();
    process.chdir(box.repo.root);
    try {
      const cc = () =>
        capturePayload(box.payload({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: 'git commit -m "dup"' }, tool_response: { stdout: `[main ${sha.slice(0, 7)}] dup` } }, "cc-1"), {
          settings: box.settings, journal: box.journal, spawn: () => true,
        });
      const viaGit = () => capturePayload("", { host: "git", settings: box.settings, journal: box.journal, spawn: () => true });

      expect(cc().signals.map((s) => s.kind)).toEqual(["checkpoint"]);
      expect(viaGit().skipped).toMatch(/already observed/);

      const sha2 = commit("dup2");
      expect(viaGit().signals.map((s) => s.kind)).toEqual(["checkpoint"]);
      const second = capturePayload(
        box.payload({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: 'git commit -m "dup2"' }, tool_response: { stdout: `[main ${sha2.slice(0, 7)}] dup2` } }, "cc-1"),
        { settings: box.settings, journal: box.journal, spawn: () => true }
      );
      expect(second.signals).toEqual([]);
      const last = box.journal.readEvents("cc-1").pop()!;
      expect(last.kind).toBe("tool_result");
      expect(last.payload.duplicate_of).toMatch(/^git:/);
    } finally {
      process.chdir(prev);
    }
  });

  it("installs a chained post-commit hook (honoring core.hooksPath) and uninstalls cleanly", () => {
    const ctx = { home: box.home, projectDir: box.repo.root, scope: "project" as const };
    const git = HOST_ADAPTERS.git;
    const hook = join(hooksDir(box.repo.root), "post-commit");

    // Existing shell hook → our block is appended, theirs kept.
    mkdirSync(join(hook, ".."), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\necho theirs\n");
    git.install(ctx);
    git.install(ctx); // idempotent
    let script = readFileSync(hook, "utf-8");
    expect(script).toContain("echo theirs");
    expect(script.match(/>>> skill-forge observe >>>/g)).toHaveLength(1);
    expect(script).toContain("skill-forge-observe --host git </dev/null");
    git.uninstall(ctx);
    expect(readFileSync(hook, "utf-8")).toBe("#!/bin/sh\necho theirs\n");

    // Non-shell hook → chained, then restored.
    writeFileSync(hook, "#!/usr/bin/env node\nconsole.log('theirs')\n");
    git.install(ctx);
    expect(readFileSync(hook, "utf-8")).toContain("post-commit.skill-forge-chained");
    git.uninstall(ctx);
    expect(readFileSync(hook, "utf-8")).toContain("console.log('theirs')");

    // core.hooksPath (husky-style) is respected.
    box.repo.git("config", "core.hooksPath", ".husky");
    const { path } = git.install(ctx);
    expect(path).toBe(join(box.repo.root, ".husky", "post-commit"));
    expect(existsSync(path)).toBe(true);
    git.uninstall(ctx);
    expect(existsSync(path)).toBe(false);
  });
});

describe("host installers", () => {
  const ctxFor = (scope: "user" | "project") => ({ home: box.home, projectDir: box.repo.root, scope });

  it("write each host's config idempotently and keep foreign entries", () => {
    const foreign = join(box.home, ".codex", "hooks.json");
    mkdirSync(join(box.home, ".codex"), { recursive: true });
    writeFileSync(foreign, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-me" }] }] } }));

    for (const name of ["claude-code", "codex", "cursor", "gemini-cli", "copilot", "kiro"] as const) {
      const adapter = HOST_ADAPTERS[name];
      const a = adapter.install(ctxFor("user"));
      const first = readFileSync(a.path, "utf-8");
      const b = adapter.install(ctxFor("user"));
      expect(b.path).toBe(a.path);
      // Idempotent: a second install leaves the file byte-identical.
      expect(readFileSync(b.path, "utf-8"), name).toBe(first);
      expect(first, name).toContain(`skill-forge-observe --host ${name}`);
      expect(adapter.uninstall(ctxFor("user")).removed, name).toBe(true);
    }
    const codex = JSON.parse(readFileSync(foreign, "utf-8"));
    expect(codex.hooks).toEqual({ Stop: [{ hooks: [{ type: "command", command: "notify-me" }] }] });
  });

  it("uses each host's documented config shape", () => {
    const cursor = HOST_ADAPTERS.cursor.install(ctxFor("project"));
    expect(cursor.path).toBe(join(box.repo.root, ".cursor", "hooks.json"));
    expect(JSON.parse(readFileSync(cursor.path, "utf-8"))).toMatchObject({ version: 1, hooks: { afterShellExecution: [{ command: "skill-forge-observe --host cursor" }] } });

    const copilot = HOST_ADAPTERS.copilot.install(ctxFor("user"));
    expect(copilot.path).toBe(join(box.home, ".copilot", "hooks", "skill-forge.json"));
    expect(JSON.parse(readFileSync(copilot.path, "utf-8")).hooks.postToolUse[0]).toEqual({
      type: "command",
      bash: "skill-forge-observe --host copilot --event postToolUse",
      powershell: "skill-forge-observe --host copilot --event postToolUse",
      timeoutSec: 10,
    });

    const gemini = HOST_ADAPTERS["gemini-cli"].install(ctxFor("user"));
    expect(JSON.parse(readFileSync(gemini.path, "utf-8")).hooks.AfterTool[0]).toMatchObject({ matcher: "*", hooks: [{ type: "command", timeout: 10_000 }] });

    const kiro = HOST_ADAPTERS.kiro.install(ctxFor("project"));
    expect(JSON.parse(readFileSync(kiro.path, "utf-8"))).toMatchObject({ version: "v1", hooks: expect.arrayContaining([expect.objectContaining({ trigger: "PostFileSave" })]) });
  });

  it("detects hosts from config dirs and never auto-installs unverified hosts or git", () => {
    for (const d of [".claude", ".codex", ".cursor", ".kiro"]) mkdirSync(join(box.home, d), { recursive: true });
    const detected = detectHosts(box.home).filter((h) => h.detected).map((h) => h.adapter.name);
    expect(detected).toEqual(expect.arrayContaining(["claude-code", "codex", "cursor", "kiro"]));
    const auto = autoInstallTargets(box.home).map((a) => a.name);
    expect(auto).toEqual(expect.arrayContaining(["claude-code", "codex", "cursor"]));
    expect(auto).not.toContain("kiro");
    expect(auto).not.toContain("git");
  });
});

describe("Entire importer [unverified listing schema]", () => {
  it("parses checkpoint listings tolerantly", () => {
    expect(parseCheckpointList(JSON.stringify([{ checkpoint_id: "a1b2c3", sessionId: "s1", commit: "deadbeef", agent: "claude-code" }]))).toEqual([
      { id: "a1b2c3", session: "s1", commit: "deadbeef", agent: "claude-code", created_at: undefined },
    ]);
    expect(parseCheckpointList(JSON.stringify({ checkpoints: [{ id: "x" }] }))[0].id).toBe("x");
  });

  it("replays Claude Code transcripts through capture and skips other formats", () => {
    const transcript = [
      { type: "user", sessionId: "s1", cwd: box.repo.root, message: { role: "user", content: "add a retry with backoff instead of failing fast" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Added exponential backoff." }] } },
    ].map((l) => JSON.stringify(l)).join("\n");
    const exec = (_cmd: string, args: string[]) => {
      if (args[1] === "list") return JSON.stringify([{ id: "cp1", session_id: "s1", commit: "abc1234def" }, { id: "cp2", agent: "gemini" }]);
      return args[2] === "cp1" ? transcript : '{"role":"model","parts":[]}';
    };
    const r = importEntireCheckpoints({ cwd: box.repo.root, exec, settings: box.settings, journal: box.journal });
    expect(r.imported).toEqual([{ checkpoint: "cp1", session: "entire:s1", events: 4 }]);
    expect(r.skipped).toEqual([{ checkpoint: "cp2", reason: "unsupported transcript format (gemini)" }]);
    const state = box.journal.loadState("entire:s1")!;
    expect(state.pending_signals.map((s) => s.kind)).toEqual(expect.arrayContaining(["tradeoff_candidate", "checkpoint"]));
    expect(importEntireCheckpoints({ cwd: box.repo.root, exec, settings: box.settings, journal: box.journal }).skipped[0].reason).toBe("already imported");
  });
});

describe("Agent Trace attribution", () => {
  const record = (rev: string) => ({
    version: "0.1.0",
    id: `t-${rev}`,
    timestamp: "2026-01-23T14:30:00Z",
    vcs: { type: "git", revision: rev },
    tool: { name: "cursor", version: "2.4.0" },
    files: [
      {
        path: "src/a.ts",
        conversations: [
          { contributor: { type: "ai", model_id: "anthropic/claude-opus-4-5" }, ranges: [{ start_line: 1, end_line: 10 }, { start_line: 20, end_line: 24, contributor: { type: "human" } }] },
        ],
      },
    ],
  });

  it("reads, stores (deduped), and attributes lines per commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-trace-"));
    try {
      writeFileSync(join(dir, "a.json"), JSON.stringify(record("abc1234")));
      writeFileSync(join(dir, "b.jsonl"), [JSON.stringify(record("def5678")), "{bad json", JSON.stringify({ version: "0.1.0" })].join("\n"));
      const { records, invalid } = readAgentTraces([dir]);
      expect(records).toHaveLength(2);
      expect(invalid).toBe(2);
      expect(storeAgentTraces(records)).toBe(2);
      expect(storeAgentTraces(records)).toBe(0);
      expect(loadAgentTraces()).toHaveLength(2);
      expect(attributionFor(records, ["abc1234ffff"])).toEqual({
        ai_lines: 10, human_lines: 5, mixed_lines: 0, unknown_lines: 0, tools: ["cursor"], models: ["anthropic/claude-opus-4-5"], records: 1,
      });
      expect(attributionFor(records, ["0000000"])).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("attaches attribution to code facts for commits that have traces", async () => {
    box.repo.write({ "src/a.ts": "export const a = 1;\n" }).commit("feat: a");
    const sha = box.repo.git("rev-parse", "HEAD").trim();
    const digest = await buildStructuralDigest({ root: box.repo.root, runtime: null, traces: [record(sha) as never] });
    expect(digest.facts.attribution).toMatchObject({ source: "agent-trace", ai_lines: 10, human_lines: 5 });
    expect(renderDigest(digest)).toContain("Attribution (Agent Trace): 10 AI-written, 0 mixed, 5 human");
    const none = await buildStructuralDigest({ root: box.repo.root, runtime: null, traces: [] });
    expect(none.facts.attribution).toBeUndefined();
  });
});
