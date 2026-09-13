import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildScoutTools } from "../../src/orchestrator/subagent/tools/registry.js";
import { ToolDef } from "../../src/orchestrator/subagent/tools/types.js";

// The scout's tools run in-process on LLM-supplied inputs, so the sandbox
// guards are security-relevant. These tests lock in the path-escape rejection
// and the result caps that keep a runaway call from blowing up context.

let root: string;
const dirs: string[] = [];

function tool(tools: ToolDef[], name: string): ToolDef {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool "${name}" not built`);
  return t;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scout-tools-"));
  dirs.push(root);
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const NEEDLE = 1;\nconst other = 2;\n");
  writeFileSync(join(root, "src", "b.ts"), "// no match here\n");
  writeFileSync(join(root, "src", "nested", "c.ts"), "const deep = NEEDLE;\n");
  writeFileSync(join(root, "README.md"), "# readme\nNEEDLE in prose\n");
  writeFileSync(join(root, "secret.txt"), "top secret\n");
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("scout tools — sandbox", () => {
  it("read_file rejects a path that escapes the sandbox root", async () => {
    const readFile = tool(buildScoutTools(root), "read_file");
    await expect(readFile.handler({ path: "../../etc/passwd" })).rejects.toThrow(/escapes sandbox/);
  });

  it("read_file rejects an absolute path outside the root", async () => {
    const readFile = tool(buildScoutTools(root), "read_file");
    // On any OS, the system temp parent is outside `root`.
    await expect(readFile.handler({ path: join(tmpdir(), "elsewhere.txt") })).rejects.toThrow(
      /escapes sandbox/
    );
  });

  it("read_file returns file contents for an in-sandbox path", async () => {
    const readFile = tool(buildScoutTools(root), "read_file");
    const out = await readFile.handler({ path: "secret.txt" });
    expect(out).toContain("top secret");
  });

  it("read_file caps the returned slice at max_bytes", async () => {
    const readFile = tool(buildScoutTools(root), "read_file");
    writeFileSync(join(root, "big.txt"), "x".repeat(500));
    const out = await readFile.handler({ path: "big.txt", max_bytes: 100 });
    expect(out).toContain("more bytes");
    expect(out.length).toBeLessThan(500);
  });
});

describe("scout tools — grep / list", () => {
  it("grep finds matches scoped by glob (direct children)", async () => {
    const grep = tool(buildScoutTools(root), "grep");
    const out = await grep.handler({ pattern: "NEEDLE", glob: "src/*.ts" });
    expect(out).toContain("src/a.ts");
    expect(out).not.toContain("README.md"); // excluded by the glob
    expect(out).not.toContain("src/b.ts"); // no NEEDLE
  });

  it("** matches both nested files and direct children of the prefix", async () => {
    const grep = tool(buildScoutTools(root), "grep");
    const out = await grep.handler({ pattern: "NEEDLE", glob: "src/**/*.ts" });
    expect(out).toContain("src/nested/c.ts"); // nested
    expect(out).toContain("src/a.ts"); // direct child — the ** zero-dirs case
  });

  it("the default **/* glob matches root-level files", async () => {
    const grep = tool(buildScoutTools(root), "grep");
    // README.md sits at the repo root; the default glob must reach it.
    const out = await grep.handler({ pattern: "NEEDLE", glob: "**/*" });
    expect(out).toContain("README.md");
    expect(out).toContain("src/a.ts");
  });

  it("grep reports no matches cleanly", async () => {
    const grep = tool(buildScoutTools(root), "grep");
    const out = await grep.handler({ pattern: "ZZZ_not_present", glob: "**/*" });
    expect(out).toBe("no matches");
  });

  it("list_files matches a glob and stays within the root", async () => {
    const list = tool(buildScoutTools(root), "list_files");
    const out = await list.handler({ glob: "src/*.ts" });
    expect(out).toContain("src/a.ts");
    expect(out).toContain("src/b.ts");
    expect(out).not.toContain("secret.txt");
  });
});

describe("scout tools — git_log", () => {
  it("degrades to an error string outside a git repo (never throws)", async () => {
    const gitLog = tool(buildScoutTools(root), "git_log");
    const out = await gitLog.handler({ limit: 5 });
    // A bare temp dir is not a git repo; the tool must return a string, not reject.
    expect(typeof out).toBe("string");
    expect(out.toLowerCase()).toMatch(/error|not a git|no commits/);
  });
});
