#!/usr/bin/env node
/**
 * Vendor the starter grammar WASM files into ./grammars with a checksum
 * manifest. Maintainer-only; the published package just ships the result.
 *
 * Why vendor instead of depending on the grammar packages: every
 * `tree-sitter-<lang>` npm package runs `node-gyp-build` on install (a native
 * build fallback) and ships its full C sources. We only need the prebuilt
 * `.wasm`, so we take it from the tarball (`npm pack` never runs the target's
 * install scripts), pin the exact version, and record a SHA-256 so a grammar
 * can never change silently. Nothing is downloaded at runtime (plan_v3 §2.3).
 *
 *   node scripts/vendor-grammars.mjs          # re-vendor + rewrite MANIFEST.json
 *   node scripts/vendor-grammars.mjs --check  # verify vendored files match the manifest
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const grammarsDir = join(here, "..", "grammars");
const manifestPath = join(grammarsDir, "MANIFEST.json");

/** Exact pins. Bump deliberately, re-run, and commit the new MANIFEST.json. */
const SOURCES = [
  { pkg: "tree-sitter-typescript", version: "0.23.2", files: ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"] },
  { pkg: "tree-sitter-javascript", version: "0.25.0", files: ["tree-sitter-javascript.wasm"] },
  { pkg: "tree-sitter-python", version: "0.25.0", files: ["tree-sitter-python.wasm"] },
  { pkg: "tree-sitter-go", version: "0.25.0", files: ["tree-sitter-go.wasm"] },
  { pkg: "tree-sitter-java", version: "0.23.5", files: ["tree-sitter-java.wasm"] },
  { pkg: "tree-sitter-rust", version: "0.24.0", files: ["tree-sitter-rust.wasm"] },
  { pkg: "tree-sitter-c-sharp", version: "0.23.5", files: ["tree-sitter-c_sharp.wasm"] },
];

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function check() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  let bad = 0;
  for (const g of manifest.grammars) {
    const path = join(grammarsDir, g.file);
    const actual = existsSync(path) ? sha256(path) : "(missing)";
    if (actual !== g.sha256) {
      console.error(`✗ ${g.file}: expected ${g.sha256}, got ${actual}`);
      bad++;
    }
  }
  if (bad) process.exit(1);
  console.log(`✓ ${manifest.grammars.length} grammars match MANIFEST.json`);
}

function vendor() {
  mkdirSync(join(grammarsDir, "licenses"), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "sf-grammars-"));
  const grammars = [];
  try {
    for (const src of SOURCES) {
      const spec = `${src.pkg}@${src.version}`;
      const tarball = execFileSync("npm", ["pack", spec, "--silent", "--pack-destination", work], {
        encoding: "utf-8",
        shell: process.platform === "win32",
      }).trim().split(/\r?\n/).pop();
      const extractTo = join(work, src.pkg);
      mkdirSync(extractTo, { recursive: true });
      // Relative paths + cwd: GNU tar reads "C:\…" as a remote host spec.
      execFileSync("tar", ["-xzf", join("..", tarball)], { cwd: extractTo });
      const pkgDir = join(extractTo, "package");
      for (const file of src.files) {
        copyFileSync(join(pkgDir, file), join(grammarsDir, file));
        grammars.push({ file, package: src.pkg, version: src.version, license: "MIT", sha256: sha256(join(grammarsDir, file)) });
        console.log(`✓ ${file} ← ${spec}`);
      }
      const license = ["LICENSE", "LICENSE.md", "LICENSE.txt"].map((f) => join(pkgDir, f)).find(existsSync);
      if (license) copyFileSync(license, join(grammarsDir, "licenses", `${src.pkg}.LICENSE`));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  writeFileSync(manifestPath, JSON.stringify({ grammars }, null, 2) + "\n");
  console.log(`✓ wrote ${manifestPath}`);
}

if (process.argv.includes("--check")) check();
else vendor();
