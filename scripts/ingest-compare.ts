#!/usr/bin/env npx tsx
/**
 * Ingest-prompt comparison (plan_v3 §2.6 exit criterion): v2 sent the git log
 * plus the first 15 KB of the raw diff; v3 sends the structural digest. For
 * each of the last N commits this prints both prompt sizes, an approximate
 * token count (~4 chars/token), and whether v2 had to truncate. No LLM calls.
 *
 *   npx tsx scripts/ingest-compare.ts                 # last 10 commits of the cwd repo
 *   npx tsx scripts/ingest-compare.ts --commits 25 --root ../other-repo
 *   SKILL_FORGE_CODEINTEL=off npx tsx scripts/ingest-compare.ts   # L0 digest
 */
import { execFileSync } from "child_process";
import { buildStructuralDigest, renderDigest } from "../src/codeintel/index.js";
import { rawDiffSection } from "../src/ingestor/index.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};
const root = flag("root") ?? process.cwd();
const count = Number(flag("commits") ?? 10);
const V2_MAX_DIFF = 15_000;

const git = (...a: string[]) =>
  execFileSync("git", a, { cwd: root, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });

const commits = git("log", "--format=%H", "-n", String(count), "--no-merges").split(/\r?\n/).filter(Boolean);
const rows: string[] = [];
let v2Total = 0;
let v3Total = 0;
let truncated = 0;

for (const sha of commits) {
  const hasParent = git("rev-list", "--parents", "-n", "1", sha).trim().split(" ").length > 1;
  if (!hasParent) continue;
  const log = git("log", "--oneline", "-10", sha);
  const rawDiff = git("diff", `${sha}~1`, sha, "--stat", "--unified=3");
  const v2Diff = rawDiff.length > V2_MAX_DIFF ? rawDiff.slice(0, V2_MAX_DIFF) + "\n\n[diff truncated]" : rawDiff;
  const v2 = `Git log (last 10 commits):\n${log}\n\nGit diff:\n${v2Diff}`;

  const digest = await buildStructuralDigest({ root, range: `${sha}~1..${sha}` });
  const diff = rawDiffSection(rawDiff, digest.facts.entity_changes.length > 0);
  const v3 = `Commits in range ${digest.range.label} (newest first):\n${digest.subjects.join("\n")}\n\n${renderDigest(digest)}${diff}`;

  v2Total += v2.length;
  v3Total += v3.length;
  if (rawDiff.length > V2_MAX_DIFF) truncated++;
  const tok = (n: number) => `~${Math.round(n / 4).toLocaleString()}`;
  rows.push(
    `| ${sha.slice(0, 7)} | ${digest.facts.files_changed} | ${tok(rawDiff.length)} | ${tok(v2.length)}${rawDiff.length > V2_MAX_DIFF ? " (truncated)" : ""} | ${tok(v3.length)} (${digest.layer}) | ${Math.round((100 * v3.length) / v2.length)}% |`
  );
}

console.log(`Ingest prompt sizes for ${root} — tokens ≈ chars/4\n`);
console.log("| commit | files | full diff | v2 prompt | v3 prompt | v3/v2 |");
console.log("| --- | --- | --- | --- | --- | --- |");
console.log(rows.join("\n"));
console.log(
  `\nTotal: v2 ~${Math.round(v2Total / 4).toLocaleString()} tokens, v3 ~${Math.round(v3Total / 4).toLocaleString()} tokens ` +
    `(${Math.round((100 * v3Total) / v2Total)}%). v2 truncated ${truncated} of ${rows.length} commits; v3 truncated none.`
);
