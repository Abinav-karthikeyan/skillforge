import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCodeIntelTools } from "../../src/orchestrator/subagent/tools/codeintel-tools.js";
import { buildScoutTools } from "../../src/orchestrator/subagent/tools/registry.js";
import { ToolDef } from "../../src/orchestrator/subagent/tools/types.js";
import { EntityExtractor } from "../../src/codeintel/entities.js";
import { buildRepoGraph, rankFiles, renderRepoMap } from "../../src/codeintel/repo-map.js";
import { loadCodeIntelRuntime, resetCodeIntelRuntime } from "../../src/codeintel/runtime.js";
import { ingestSession } from "../../src/ingestor/index.js";
import { applyCodeFactsRule } from "../../src/translators/base.js";
import { LLMClient } from "../../src/claude/types.js";
import { SessionSummary } from "../../src/types/session.js";
import { TempRepo } from "./helpers.js";

let repo: TempRepo;

beforeAll(() => {
  repo = new TempRepo();
  repo
    .write({
      "src/core.ts": `export class Engine {
  run(task: string): number {
    if (task === "") { return 0; }
    return task.length;
  }
}
export function makeEngine() { return new Engine(); }
`,
      "src/cli.ts": `import { makeEngine } from "./core";
export function main(argv: string[]) { return makeEngine().run(argv[0] ?? ""); }
`,
      "src/api.ts": `import { makeEngine, Engine } from "./core";
export function handle(e: Engine) { return makeEngine().run("x") + e.run("y"); }
`,
      "src/lonely.ts": `export function lonely() { return 1; }\n`,
    })
    .commit("init");
  repo
    .write({
      "src/core.ts": `export class Engine {
  run(task: string): number {
    if (task === "" || task === "noop") { return 0; }
    for (const c of task) { if (c === "!") { return -1; } }
    return task.length;
  }
}
export function makeEngine() { return new Engine(); }
export function makeEngines(n: number) { return Array.from({ length: n }, makeEngine); }
`,
    })
    .commit("feat: engine guards and batch factory");
});

afterAll(() => repo?.dispose());

const tool = (tools: ToolDef[], name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

describe("scout tool registry", () => {
  it("grants the four lexical tools plus the six code-intelligence tools", () => {
    expect(buildScoutTools(repo.root).map((t) => t.name)).toEqual([
      "grep", "read_file", "list_files", "git_log",
      "outline", "find_symbol", "references", "structural_diff", "metrics", "repo_map",
    ]);
  });
});

describe("code-intelligence scout tools (L1)", () => {
  const tools = () => buildCodeIntelTools(repo.root);

  it("outline lists definitions with complexity", async () => {
    const out = await tool(tools(), "outline").handler({ path: "src/core.ts" });
    expect(out).toContain("method Engine.run [exported, cc 5]");
    expect(out).toContain("function makeEngines [exported, cc 1]");
  });

  it("find_symbol resolves simple and qualified names", async () => {
    const t = tools();
    expect(await tool(t, "find_symbol").handler({ name: "run" })).toContain("src/core.ts:L2-6 method Engine.run");
    expect(await tool(t, "find_symbol").handler({ name: "Engine.run" })).toContain("Engine.run");
    expect(await tool(t, "find_symbol").handler({ name: "nope" })).toBe("no definitions found");
  });

  it("references are name-based and flagged approximate", async () => {
    const out = await tool(tools(), "references").handler({ symbol: "makeEngine" });
    expect(out.split("\n")[0]).toMatch(/^approximate: true — ~\d+ file\(s\) reference "makeEngine"/);
    expect(out).toContain("src/cli.ts");
    expect(out).toContain("src/api.ts");
  });

  it("structural_diff renders the entity diff for a range and rejects shell metacharacters", async () => {
    const t = tools();
    const out = await tool(t, "structural_diff").handler({ rev_range: "HEAD~1..HEAD" });
    expect(out).toContain("~ method Engine.run [exported, cc 2→5]");
    expect(out).toContain("+ function makeEngines");
    expect(await tool(t, "structural_diff").handler({ rev_range: "HEAD; rm -rf /" })).toBe("error: invalid rev_range");
  });

  it("metrics reports per-file and per-symbol complexity", async () => {
    const t = tools();
    expect(await tool(t, "metrics").handler({ target: "src/core.ts" })).toMatch(/^3 functions, total cyclomatic complexity 7/);
    expect(await tool(t, "metrics").handler({ target: "run" })).toContain("cc 5  Engine.run");
  });

  it("repo_map ranks the shared core above leaf files", async () => {
    const out = await tool(tools(), "repo_map").handler({ budget_tokens: 400 });
    const order = out.split("\n").filter((l) => l.endsWith(":"));
    expect(order[0]).toBe("src/core.ts:");
    expect(out).toMatch(/\(\d+ of 4 parsed files shown\)/);
  });

  it("keeps every path inside the sandbox", async () => {
    await expect(tool(tools(), "outline").handler({ path: "../../etc/passwd" })).resolves.toMatch(/^error/);
    await expect(tool(tools(), "repo_map").handler({ focus: ["../outside.ts"] })).rejects.toThrow(/escapes sandbox/);
  });
});

describe("repo map ranking", () => {
  it("personalizes toward focus files", async () => {
    const runtime = (await loadCodeIntelRuntime())!;
    const graph = await buildRepoGraph(repo.root, new EntityExtractor(runtime));
    const neutral = rankFiles(graph);
    const focused = rankFiles(graph, ["src/lonely.ts"]);
    expect(focused.get("src/lonely.ts")!).toBeGreaterThan(neutral.get("src/lonely.ts")!);
    expect(renderRepoMap(graph, focused, 50).split("\n")[0]).toBe("src/lonely.ts:");
  });
});

describe("ingestion with a structural digest", () => {
  const SUMMARY = {
    one_liner: "Hardened the engine and added a batch factory",
    problem_statement: "p",
    approach: "a",
    technologies: ["TypeScript"],
    complexity_signals: { files_touched: 99, lines_changed: 9999, test_coverage: true, debugging_involved: true },
  };

  it("sends the digest instead of a truncated diff and attaches measured code facts", async () => {
    const chat = vi.fn(async () => JSON.stringify({ source_tool: "claude-code", summary: SUMMARY }));
    const client: LLMClient = { chat };
    const session = await ingestSession(client, undefined, { root: repo.root });

    const [system, user] = chat.mock.calls[0] as unknown as [string, string];
    expect(system).toMatch(/structural digest computed deterministically/);
    expect(user).toContain("Structural digest (L1 · tree-sitter)");
    expect(user).toContain("~ method Engine.run [exported, cc 2→5]");
    expect(user).not.toContain("[diff truncated");

    const facts = session.summary.code_facts!;
    expect(facts.layer).toBe("L1");
    expect(facts.classification).toBe("feature");
    // The LLM's invented sizes are replaced by measured ones; its debugging judgment stays.
    expect(session.summary.complexity_signals).toEqual({
      files_touched: 1,
      lines_changed: facts.lines_added + facts.lines_removed,
      test_coverage: false,
      debugging_involved: true,
    });
  });

  it("attaches code facts to a pre-formed summary only when asked", async () => {
    const client: LLMClient = { chat: vi.fn() };
    const raw = JSON.stringify({ session_id: "s", timestamp: "t", summary: SUMMARY });
    const plain = await ingestSession(client, raw, { root: repo.root });
    expect(plain.summary.code_facts).toBeUndefined();
    const enriched = await ingestSession(client, raw, { root: repo.root, withCodeFacts: true });
    expect(enriched.summary.code_facts?.entities?.added).toBe(1);
    expect(client.chat).not.toHaveBeenCalled();
  });

  it("falls back to L0 facts when code intelligence is disabled", async () => {
    process.env.SKILL_FORGE_CODEINTEL = "off";
    resetCodeIntelRuntime();
    try {
      const chat = vi.fn(async () => JSON.stringify({ summary: SUMMARY }));
      const session = await ingestSession({ chat }, undefined, { root: repo.root });
      expect(session.summary.code_facts?.layer).toBe("L0");
      expect((chat.mock.calls[0] as unknown as [string, string])[1]).toContain("L0 · git only");
    } finally {
      delete process.env.SKILL_FORGE_CODEINTEL;
      resetCodeIntelRuntime();
    }
  });
});

describe("translator code-facts rule", () => {
  const base: SessionSummary = {
    session_id: "s",
    timestamp: "t",
    source_tool: "claude-code",
    summary: { one_liner: "x", problem_statement: "p", approach: "a", tradeoffs: [], dead_ends: [], technologies: [], patterns_used: [] },
  };

  it("leaves prompts untouched without code facts", () => {
    expect(applyCodeFactsRule("PROMPT", base)).toBe("PROMPT");
  });

  it("constrains metrics to code facts when present", () => {
    const withFacts: SessionSummary = {
      ...base,
      summary: {
        ...base.summary,
        code_facts: {
          layer: "L1", source: "ast", range: "a..b", files_changed: 1, lines_added: 1, lines_removed: 0,
          languages: {}, classification: "refactor", classification_reasons: [], entity_changes: [],
          public_api: [], blast_radius: [],
        },
      },
    };
    const prompt = applyCodeFactsRule("PROMPT", withFacts);
    expect(prompt.startsWith("PROMPT\n---\nCode facts rule")).toBe(true);
    expect(prompt).toMatch(/may ONLY come from `code_facts`/);
    expect(prompt).toMatch(/"~N"/);
  });
});
