import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildStructuralDigest, renderDigest, StructuralDigest } from "../../src/codeintel/digest.js";
import { EMPTY_TREE } from "../../src/codeintel/git.js";
import { loadCodeIntelRuntime } from "../../src/codeintel/runtime.js";
import { CodeIntelRuntime } from "../../src/codeintel/types.js";
import { TempRepo } from "./helpers.js";

const V1 = {
  "src/limiter.ts": `export class RateLimiter {
  allow(key: string): boolean {
    return key.length > 0;
  }
}
export function oldName(a: number) {
  const doubled = a * 2;
  return doubled + 1;
}
function stays() { return 42; }
`,
  "src/util.ts": `export function moveMe(x: number) {
  const scaled = x * 2 * 3;
  return scaled - 1;
}
export function keep() { return 1; }
`,
  "src/other.ts": `import { RateLimiter } from "./limiter";
export function guard(l: RateLimiter, k: string) { return l.allow(k); }
`,
  "README.md": "# demo\n",
  "package.json": JSON.stringify({ name: "demo", dependencies: { express: "^4.0.0" } }, null, 2),
  ".gitattributes": "gen/** linguist-generated=true\n",
};

const V2 = {
  "src/limiter.ts": `export class RateLimiter {
  allow(key: string): boolean {
    if (key.length === 0 || key === "blocked") { return false; }
    for (const ch of key) { if (ch === "!") { return false; } }
    return true;
  }
}
export function newName(a: number) {
  const doubled = a * 2;
  return doubled + 1;
}
export function createLimiter(): RateLimiter { return new RateLimiter(); }
`,
  "src/util.ts": `export function keep() { return 1; }
`,
  "src/math.ts": `export function moveMe(x: number) {
  const scaled = x * 2 * 3;
  return scaled - 1;
}
export function square(n: number) { return n * n; }
`,
  "tests/limiter.test.ts": `import { createLimiter } from "../src/limiter";
test("allows", () => { expect(createLimiter().allow("a")).toBe(true); });
`,
  "gen/client.ts": `export function generated1() { return 1; }\n`.repeat(50),
  "package-lock.json": `{"lockfileVersion": 3}\n`,
  "package.json": JSON.stringify({ name: "demo", dependencies: { express: "^4.0.0", ioredis: "^5.0.0" } }, null, 2),
  "README.md": "# demo\n\nNow with sliding windows.\n",
};

let repo: TempRepo;
let runtime: CodeIntelRuntime;
let l1: StructuralDigest;

beforeAll(async () => {
  runtime = (await loadCodeIntelRuntime())!;
  expect(runtime, "codeintel companion must resolve in the dev workspace").toBeTruthy();
  repo = new TempRepo();
  repo.write(V1).commit("initial limiter");
  repo.write(V2).commit("feat: harden RateLimiter.allow and add createLimiter");
  l1 = await buildStructuralDigest({ root: repo.root, runtime });
});

afterAll(() => repo?.dispose());

const change = (d: StructuralDigest, symbol: string) => d.facts.entity_changes.find((c) => c.symbol === symbol);

describe("structural digest (L1)", () => {
  it("excludes generated files and lockfiles from every metric", () => {
    expect(l1.skipped.sort()).toEqual(["gen/client.ts", "package-lock.json"]);
    expect(l1.files.map((f) => f.path)).not.toContain("gen/client.ts");
    expect(l1.facts.files_changed).toBe(6);
  });

  it("classifies entity changes: modified with complexity delta, rename, add, remove, cross-file move", () => {
    expect(change(l1, "RateLimiter.allow")).toMatchObject({
      change: "modified",
      kind: "method",
      exported: true,
      complexity_before: 1,
      // if + || + for + inner if
      complexity_after: 5,
    });
    expect(change(l1, "newName")).toMatchObject({ change: "renamed", previous_symbol: "oldName" });
    expect(change(l1, "createLimiter")).toMatchObject({ change: "added", exported: true, complexity_after: 1 });
    expect(change(l1, "stays")).toMatchObject({ change: "removed", exported: false });
    expect(change(l1, "moveMe")).toMatchObject({ change: "moved", path: "src/math.ts", previous_path: "src/util.ts" });
    expect(change(l1, "square")).toMatchObject({ change: "added" });
    // The move is not double-counted as an add plus a remove.
    expect(l1.facts.entity_changes.filter((c) => c.symbol === "moveMe")).toHaveLength(1);
    expect(l1.facts.entities).toEqual({ added: 2, modified: 1, removed: 1, renamed: 1, moved: 1 });
  });

  it("totals touched complexity and lists public API changes", () => {
    // before: allow 1 + oldName 1 + stays 1; after: allow 5 + newName 1 + createLimiter 1 + square 1
    expect(l1.facts.complexity).toEqual({ touched_before: 3, touched_after: 8 });
    const api = l1.facts.public_api.map((p) => `${p.change}:${p.symbol}`);
    expect(api).toEqual(expect.arrayContaining(["added:createLimiter", "modified:RateLimiter.allow", "renamed:newName"]));
    expect(api.some((a) => a.endsWith(":stays"))).toBe(false);
  });

  it("classifies the change as a feature, with reasons", () => {
    expect(l1.facts.classification).toBe("feature");
    expect(l1.facts.classification_reasons.join(" ")).toMatch(/2 entities added/);
  });

  it("links tests by name and estimates blast radius (approximate)", () => {
    expect(l1.facts.tests?.test_files_changed).toBe(1);
    const linked = l1.facts.tests?.linked.find((t) => t.test_file === "tests/limiter.test.ts");
    expect(linked?.symbols).toEqual(expect.arrayContaining(["createLimiter"]));
    const allow = l1.facts.blast_radius.find((b) => b.symbol === "RateLimiter.allow");
    expect(allow).toMatchObject({ approximate: true });
    expect(allow!.referencing_files).toBeGreaterThanOrEqual(1);
  });

  it("fingerprints frameworks and newly added dependencies", () => {
    expect(l1.facts.fingerprint?.frameworks).toContain("Express");
    expect(l1.facts.fingerprint?.dependencies_added).toEqual(["ioredis"]);
    expect(l1.facts.fingerprint?.languages[0]).toBe("TypeScript");
  });

  it("renders a complete digest: every changed file is listed", () => {
    const text = renderDigest(l1);
    expect(text).toMatch(/complete; every changed file is listed/);
    for (const f of l1.files) expect(text).toContain(f.path);
    expect(text).toContain("~ method RateLimiter.allow [exported, cc 1→5]");
    expect(text).toContain("↻ function newName (was oldName)");
    expect(text).toContain("→ function moveMe (from src/util.ts)");
    expect(text).toContain("Excluded from metrics (generated/vendored/lockfiles): ");
  });

  it("collapses per-entity detail to counts under a tight budget — but still lists every file", () => {
    const text = renderDigest(l1, 900);
    for (const f of l1.files) expect(text).toContain(f.path);
    expect(text).toMatch(/shown as per-kind counts/);
  });
});

describe("structural digest (L0 fallback)", () => {
  it("degrades to file-level facts with hunk-header symbols when no runtime is available", async () => {
    const l0 = await buildStructuralDigest({ root: repo.root, runtime: null });
    expect(l0.layer).toBe("L0");
    expect(l0.facts.source).toBe("git");
    expect(l0.facts.entities).toBeUndefined();
    expect(l0.facts.entity_changes).toEqual([]);
    expect(l0.facts.files_changed).toBe(l1.facts.files_changed);
    expect(l0.facts.lines_added).toBe(l1.facts.lines_added);
    expect(l0.facts.hunk_symbols?.length).toBeGreaterThan(0);
    expect(renderDigest(l0)).toMatch(/L0 · git only/);
  });
});

describe("ranges and classification edge cases", () => {
  it("diffs a root commit against the empty tree", async () => {
    const solo = new TempRepo();
    try {
      solo.write({ "a.py": "def hello():\n    return 1\n" }).commit("init");
      const d = await buildStructuralDigest({ root: solo.root, runtime });
      expect(d.range.base).toBe(EMPTY_TREE);
      expect(d.facts.range).toMatch(/^\(root\)\.\./);
      expect(change(d, "hello")).toMatchObject({ change: "added", kind: "function" });
    } finally {
      solo.dispose();
    }
  });

  it("calls a rename-only change a refactor and a fix-titled edit a fix", async () => {
    const r = new TempRepo();
    try {
      r.write({ "m.go": "package m\n\nfunc Compute(a int) int {\n\tif a > 1 {\n\t\treturn a\n\t}\n\treturn 0\n}\n" }).commit("init");
      r.write({ "m.go": "package m\n\nfunc Calculate(a int) int {\n\tif a > 1 {\n\t\treturn a\n\t}\n\treturn 0\n}\n" }).commit("rename compute");
      const renamed = await buildStructuralDigest({ root: r.root, runtime });
      expect(renamed.facts.classification).toBe("refactor");
      expect(change(renamed, "Calculate")).toMatchObject({ change: "renamed", previous_symbol: "Compute" });

      r.write({ "m.go": "package m\n\nfunc Calculate(a int) int {\n\tif a >= 1 {\n\t\treturn a\n\t}\n\treturn 0\n}\n" }).commit("fix: off-by-one in Calculate");
      const fixed = await buildStructuralDigest({ root: r.root, runtime });
      expect(fixed.facts.classification).toBe("fix");

      const docs = await buildStructuralDigest({ root: r.root, runtime, range: "HEAD~2..HEAD~1" });
      expect(docs.facts.range).toMatch(/\.\./);
    } finally {
      r.dispose();
    }
  });

  it("labels docs-only and test-only changes", async () => {
    const r = new TempRepo();
    try {
      r.write({ "README.md": "a\n", "src/a.ts": "export const a = 1;\n" }).commit("init");
      r.write({ "README.md": "b\n" }).commit("docs");
      expect((await buildStructuralDigest({ root: r.root, runtime })).facts.classification).toBe("docs");
      r.write({ "src/a.test.ts": "test('x', () => {});\n" }).commit("tests");
      expect((await buildStructuralDigest({ root: r.root, runtime })).facts.classification).toBe("test");
    } finally {
      r.dispose();
    }
  });
});
