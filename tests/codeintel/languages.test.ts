import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { EntityExtractor } from "../../src/codeintel/entities.js";
import { LANGUAGES, LanguageId, languageForPath } from "../../src/codeintel/languages.js";
import { loadCodeIntelRuntime } from "../../src/codeintel/runtime.js";
import { FileEntities } from "../../src/codeintel/types.js";

/**
 * Contract tests: one fixture snippet per starter language, with the exact
 * definitions, export flags, and cyclomatic complexity a human count gives.
 * When a grammar is bumped (packages/codeintel/scripts/vendor-grammars.mjs),
 * these are the tests that say whether the walker rules still hold.
 */
const SNIPPETS: Record<LanguageId, string> = {
  typescript: `import { x } from "./dep";
export interface Limits { max: number }
export type Key = string;
export enum Mode { A, B }
export class RateLimiter {
  private hits = 0;
  constructor(private max: number) {}
  allow(key: Key): boolean {
    if (this.hits > this.max && key) { return false; }
    for (const k of [key]) { helper(k); }
    return key ? true : false;
  }
  private reset() { this.hits = 0; }
  handler = (n: number) => n > 1 || n < 0;
}
export function createLimiter(max: number): RateLimiter { return new RateLimiter(max); }
const local = () => { function inner() {} return 1; };
function helper(k: string) { switch (k) { case "a": return 1; case "b": return 2; default: return 0; } }
`,
  tsx: `export function Badge({ n }: { n: number }) { return n > 9 ? <b>9+</b> : <b>{n}</b>; }
`,
  javascript: `import fs from "node:fs";
export class Store { get(k) { return k ?? null; } }
export const make = (a) => a && new Store();
function priv() { try { fs.readFileSync("x"); } catch (e) { return 1; } }
`,
  python: `import os
from collections import defaultdict
class Limiter:
    def allow(self, key):
        if key and self.ok(key):
            return True
        elif key is None:
            return False
        return [k for k in key if k]
    def _reset(self):
        pass
def create(n):
    def inner():
        return 1
    return Limiter() if n else None
def _private():
    os.getcwd()
`,
  go: `package main
import (
  "fmt"
  "net/http"
)
type Server struct { addr string }
type Handler interface { Serve() }
func (s *Server) Start(ctx int) error {
  if ctx > 0 && s.addr != "" { return nil }
  for i := 0; i < 3; i++ { fmt.Println(i) }
  switch ctx { case 1: return nil; case 2: return nil; default: }
  return http.ListenAndServe(s.addr, nil)
}
func newServer() *Server { return &Server{addr: ":80"} }
`,
  java: `package a;
import java.util.List;
public class Cache {
  private int size;
  public Cache(int size) { this.size = size; }
  public boolean put(String k) {
    if (k == null || size == 0) { return false; }
    for (String s : List.of(k)) { helper(s); }
    switch (k) { case "a": return true; default: return false; }
  }
  private void helper(String s) { try { new Cache(1); } catch (Exception e) {} }
}
interface Store { void save(); }
`,
  rust: `use std::collections::HashMap;
pub struct Pool { size: usize }
pub trait Reset { fn reset(&mut self); }
impl Pool {
  pub fn new(size: usize) -> Self { Pool { size } }
  fn grow(&mut self, n: usize) -> usize {
    if n > 0 && self.size < 10 { self.size += n; }
    match n { 0 => 0, 1 => 1, _ => 2 }
  }
}
impl Reset for Pool { fn reset(&mut self) { self.size = 0; } }
fn helper() { let m: HashMap<u8, u8> = HashMap::new(); }
`,
  csharp: `using System;
using System.Collections.Generic;
namespace App {
  public class Queue {
    public Queue(int n) { }
    public bool Push(string item) {
      if (item == null || item.Length == 0) { return false; }
      foreach (var c in item) { Helper(c); }
      switch (item) { case "a": return true; default: return false; }
    }
    private void Helper(char c) { var q = new Queue(1); }
  }
  public interface IStore { void Save(); }
  internal struct Point { }
}
`,
};

type Expected = Array<[kind: string, qualified: string, exported: boolean, complexity: number]>;

const EXPECTED: Record<LanguageId, { defs: Expected; refs: string[]; imports: string[] }> = {
  typescript: {
    defs: [
      ["interface", "Limits", true, 0],
      ["type", "Key", true, 0],
      ["enum", "Mode", true, 0],
      ["class", "RateLimiter", true, 0],
      ["method", "RateLimiter.constructor", true, 1],
      // if + && + for + ternary
      ["method", "RateLimiter.allow", true, 5],
      ["method", "RateLimiter.reset", false, 1],
      ["method", "RateLimiter.handler", true, 2],
      ["function", "createLimiter", true, 1],
      ["function", "local", false, 1],
      ["function", "inner", false, 1],
      // two cases; default doesn't add a path
      ["function", "helper", false, 3],
    ],
    refs: ["Key", "helper", "RateLimiter"],
    imports: ["./dep"],
  },
  tsx: { defs: [["function", "Badge", true, 2]], refs: [], imports: [] },
  javascript: {
    defs: [
      ["class", "Store", true, 0],
      ["method", "Store.get", true, 2],
      ["function", "make", true, 2],
      ["function", "priv", false, 2],
    ],
    refs: ["Store", "readFileSync"],
    imports: ["node:fs"],
  },
  python: {
    defs: [
      ["class", "Limiter", true, 0],
      // if + and + elif + comprehension for + comprehension if
      ["method", "Limiter.allow", true, 6],
      ["method", "Limiter._reset", false, 1],
      ["function", "create", true, 2],
      ["function", "inner", false, 1],
      ["function", "_private", false, 1],
    ],
    refs: ["ok", "Limiter", "getcwd"],
    imports: ["os", "collections"],
  },
  go: {
    defs: [
      ["struct", "Server", true, 0],
      ["interface", "Handler", true, 0],
      // if + && + for + two cases
      ["method", "Server.Start", true, 6],
      ["function", "newServer", false, 1],
    ],
    refs: ["Println", "ListenAndServe", "Server"],
    imports: ["fmt", "net/http"],
  },
  java: {
    defs: [
      ["class", "Cache", true, 0],
      ["method", "Cache.Cache", true, 1],
      ["method", "Cache.put", true, 5],
      ["method", "Cache.helper", false, 2],
      ["interface", "Store", false, 0],
      ["method", "Store.save", false, 1],
    ],
    refs: ["helper", "Cache"],
    imports: ["java.util.List"],
  },
  rust: {
    defs: [
      ["struct", "Pool", true, 0],
      ["trait", "Reset", true, 0],
      ["method", "Pool.new", true, 1],
      // if + && + (3 arms − 1)
      ["method", "Pool.grow", false, 5],
      // trait-impl methods are public through the trait
      ["method", "Pool.reset", true, 1],
      ["function", "helper", false, 1],
    ],
    refs: ["Pool", "HashMap"],
    imports: ["std::collections::HashMap"],
  },
  csharp: {
    defs: [
      ["class", "App.Queue", true, 0],
      ["method", "App.Queue.Queue", true, 1],
      ["method", "App.Queue.Push", true, 5],
      ["method", "App.Queue.Helper", false, 1],
      ["interface", "App.IStore", true, 0],
      ["method", "App.IStore.Save", true, 1],
      ["struct", "App.Point", false, 0],
    ],
    refs: ["Helper", "Queue"],
    imports: ["System", "System.Collections.Generic"],
  },
};

let extractor: EntityExtractor;
beforeAll(async () => {
  const runtime = await loadCodeIntelRuntime();
  if (!runtime) throw new Error("codeintel companion not resolvable — run `npm install` at the repo root (workspace)");
  extractor = new EntityExtractor(runtime);
});

describe("language contract tests", () => {
  for (const id of Object.keys(SNIPPETS) as LanguageId[]) {
    describe(id, () => {
      let entities: FileEntities;
      beforeAll(async () => {
        entities = (await extractor.extract(SNIPPETS[id], LANGUAGES[id]))!;
      });

      it("parses without errors", () => {
        expect(entities).toBeTruthy();
        expect(entities.parse_error).toBe(false);
      });

      it("finds every definition with kind, qualified name, export flag, and complexity", () => {
        const got = entities.definitions.map((d) => [d.kind, d.qualified, d.exported, d.complexity]);
        expect(got).toEqual(EXPECTED[id].defs);
      });

      it("collects references and imports", () => {
        for (const r of EXPECTED[id].refs) expect(entities.references).toContain(r);
        expect(entities.imports).toEqual(EXPECTED[id].imports);
      });
    });
  }
});

describe("entity details", () => {
  it("captures signatures without bodies and line ranges", async () => {
    const e = (await extractor.extract(SNIPPETS.typescript, LANGUAGES.typescript))!;
    const allow = e.definitions.find((d) => d.qualified === "RateLimiter.allow")!;
    expect(allow.signature).toBe("allow(key: Key): boolean");
    expect([allow.start_line, allow.end_line]).toEqual([8, 12]);
  });

  it("hashes bodies so a pure rename (or reformat) keeps the same hash", async () => {
    const a = (await extractor.extract("export function alpha(x: number) {\n  return x + 1;\n}\n", LANGUAGES.typescript))!;
    const b = (await extractor.extract("export function beta(x: number) { return x + 1; }\n", LANGUAGES.typescript))!;
    const c = (await extractor.extract("export function alpha(x: number) { return x + 2; }\n", LANGUAGES.typescript))!;
    expect(a.definitions[0].body_hash).toBe(b.definitions[0].body_hash);
    expect(a.definitions[0].body_hash).not.toBe(c.definitions[0].body_hash);
  });

  it("caches by content hash", async () => {
    const first = await extractor.extract(SNIPPETS.go, LANGUAGES.go);
    const second = await extractor.extract(SNIPPETS.go, LANGUAGES.go);
    expect(second).toBe(first);
  });

  it("maps file extensions and skips declaration files", () => {
    expect(languageForPath("src/a.ts")?.id).toBe("typescript");
    expect(languageForPath("src/a.d.ts")).toBeNull();
    expect(languageForPath("src/App.tsx")?.id).toBe("tsx");
    expect(languageForPath("lib/x.mjs")?.id).toBe("javascript");
    expect(languageForPath("a.py")?.id).toBe("python");
    expect(languageForPath("main.go")?.id).toBe("go");
    expect(languageForPath("A.java")?.id).toBe("java");
    expect(languageForPath("lib.rs")?.id).toBe("rust");
    expect(languageForPath("Program.cs")?.id).toBe("csharp");
    expect(languageForPath("README.md")).toBeNull();
  });
});

describe("vendored grammars", () => {
  it("match the checksums pinned in MANIFEST.json", () => {
    const dir = join(__dirname, "..", "..", "packages", "codeintel", "grammars");
    const manifest = JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf-8")) as {
      grammars: Array<{ file: string; sha256: string }>;
    };
    expect(manifest.grammars).toHaveLength(8);
    for (const g of manifest.grammars) {
      const actual = createHash("sha256").update(readFileSync(join(dir, g.file))).digest("hex");
      expect(actual, g.file).toBe(g.sha256);
    }
  });
});
